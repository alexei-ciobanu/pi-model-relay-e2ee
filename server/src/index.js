#!/usr/bin/env node
import { once } from "node:events";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  deriveKey,
  E2EE_VERSION,
  loadMasterKey,
  openJson,
  requestAad,
  responseAad,
  sealJson,
  validateRequestEnvelope,
} from "../../shared/e2ee.js";
import { applyNativeReplayPlan, extractCompactRequestTemplate, validateCompactPayload } from "./native-compaction.js";

const HOST = process.env.CODEX_RELAY_HOST || "127.0.0.1";
const PORT = Number(process.env.CODEX_RELAY_PORT || "8787");
const MAX_BODY_BYTES = Number(process.env.CODEX_RELAY_MAX_BODY_BYTES || 50 * 1024 * 1024);
const KEY_FILE = process.env.CODEX_RELAY_KEY_FILE || join(homedir(), ".config", "codex-relay-e2ee", "key");
const UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";
const UPSTREAM_COMPACT = `${UPSTREAM}/compact`;
const PROVIDER = "openai-codex";
const INNER_API = "openai-codex-responses";
const RELAY_PROVIDER = "codex-relay-e2ee";
const RELAY_API = "codex-relay-e2ee-v1";
const REPLAY_TTL_MS = 2 * 60_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function configurationError(message) {
  console.error(message);
  process.exit(1);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  configurationError(`Invalid CODEX_RELAY_PORT: ${process.env.CODEX_RELAY_PORT || ""}`);
}
if (!Number.isSafeInteger(MAX_BODY_BYTES) || MAX_BODY_BYTES < 1) {
  configurationError(`Invalid CODEX_RELAY_MAX_BODY_BYTES: ${process.env.CODEX_RELAY_MAX_BODY_BYTES || ""}`);
}

let e2eeRequestKey;
let e2eeResponseKey;
try {
  const masterKey = loadMasterKey(KEY_FILE);
  e2eeRequestKey = deriveKey(masterKey, "request");
  e2eeResponseKey = deriveKey(masterKey, "response");
} catch (error) {
  configurationError(
    `Could not load CODEX_RELAY_KEY_FILE (${KEY_FILE}): ${error instanceof Error ? error.message : String(error)}`,
  );
}

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const replayCache = new Map();

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;

    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, "Invalid JSON request body"));
      }
    });
    req.on("aborted", () => reject(new HttpError(400, "Request was aborted")));
    req.on("error", reject);
  });
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function accountIdFromJwt(token) {
  const [, payload] = token.split(".");
  if (!payload) return undefined;
  const json = JSON.parse(decodeBase64Url(payload));
  return json?.["https://api.openai.com/auth"]?.chatgpt_account_id;
}

async function getCodexAuth() {
  const accessToken = await authStorage.getApiKey(PROVIDER);
  if (!accessToken) throw new Error(`No Pi OAuth token for ${PROVIDER}. Run /login in Pi on this relay host first.`);

  const credential = authStorage.get(PROVIDER);
  const accountId =
    credential?.type === "oauth" && typeof credential.accountId === "string"
      ? credential.accountId
      : accountIdFromJwt(accessToken);
  if (!accountId) throw new Error("Could not determine ChatGPT accountId from Pi OAuth token.");
  return { accessToken, accountId };
}

async function writeWithBackpressure(res, chunk) {
  if (res.destroyed || res.writableEnded) throw new Error("Client disconnected");
  if (!res.write(chunk)) await once(res, "drain");
}

function attachDisconnectAbort(req, res, controller) {
  req.on("aborted", () => controller.abort());
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
}

function pruneReplayCache(now) {
  for (const [id, expires] of replayCache) if (expires <= now) replayCache.delete(id);
}

function acceptRequestId(id, now) {
  pruneReplayCache(now);
  if (replayCache.has(id)) throw new HttpError(409, "Encrypted request replay rejected");
  replayCache.set(id, now + REPLAY_TTL_MS);
}

function validateEncryptedPayload(payload) {
  if (!payload || typeof payload !== "object") throw new HttpError(400, "Invalid encrypted request");
  if (typeof payload.modelId !== "string" || !payload.modelId) throw new HttpError(400, "Invalid encrypted request");
  if (!payload.context || typeof payload.context !== "object" || !Array.isArray(payload.context.messages)) {
    throw new HttpError(400, "Invalid encrypted request");
  }
  if (
    payload.options !== undefined &&
    (!payload.options || typeof payload.options !== "object" || Array.isArray(payload.options))
  ) {
    throw new HttpError(400, "Invalid encrypted request");
  }
  return payload;
}

function sanitizeRemoteOptions(options) {
  const sanitized = {};
  if (!options) return sanitized;
  for (const key of [
    "temperature",
    "maxTokens",
    "reasoning",
    "transport",
    "cacheRetention",
    "sessionId",
    "timeoutMs",
    "websocketConnectTimeoutMs",
    "maxRetries",
    "maxRetryDelayMs",
    "metadata",
  ]) {
    if (options[key] !== undefined) sanitized[key] = options[key];
  }
  return sanitized;
}

function restoreInnerContext(context) {
  return {
    ...context,
    messages: context.messages.map((message) => {
      if (message?.role !== "assistant" || message.provider !== RELAY_PROVIDER || message.api !== RELAY_API) {
        return message;
      }
      return { ...message, provider: PROVIDER, api: INNER_API };
    }),
  };
}

function compactAssistantEvent(event) {
  if (event.type === "start" || event.type === "done" || event.type === "error") return event;
  const compact = { ...event };
  delete compact.partial;
  if (event.type.endsWith("_start") || event.type === "text_end" || event.type === "thinking_end") {
    compact.block = event.partial?.content?.[event.contentIndex];
  }
  return compact;
}

async function writeEncryptedFrame(res, id, sequence, wireEvent) {
  const sealed = sealJson(e2eeResponseKey, responseAad("stream", id, sequence), wireEvent);
  const frame = JSON.stringify({ v: E2EE_VERSION, id, sequence, ...sealed });
  await writeWithBackpressure(res, `${frame}\n`);
}

function sendEncryptedJson(res, id, wireValue) {
  const sealed = sealJson(e2eeResponseKey, responseAad("compact", id, 0), wireValue);
  sendJson(res, 200, { v: E2EE_VERSION, id, sequence: 0, ...sealed });
}

async function encryptedCompact(req, res) {
  let envelope;
  let payload;
  try {
    envelope = validateRequestEnvelope(await readJsonBody(req));
    payload = validateCompactPayload(
      openJson(e2eeRequestKey, requestAad("compact", envelope.id, envelope.timestamp), envelope),
    );
    acceptRequestId(envelope.id, Date.now());
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    return sendJson(res, status, {
      error: status === 409 ? "Encrypted request replay rejected" : "Invalid encrypted request",
    });
  }

  const abortController = new AbortController();
  attachDisconnectAbort(req, res, abortController);
  try {
    const model = modelRegistry.find(PROVIDER, payload.modelId);
    if (!model) throw new Error(`Unsupported Codex model: ${payload.modelId}`);
    const { accessToken, accountId } = await getCodexAuth();
    const clientRequestId = String(payload.clientRequestId || payload.sessionId || `pi-compact-${envelope.id}`);
    const upstream = await fetch(UPSTREAM_COMPACT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        originator: "pi",
        "openai-beta": "responses=experimental",
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "codex-relay-e2ee",
        "x-client-request-id": clientRequestId,
        session_id: String(payload.sessionId || clientRequestId),
      },
      body: JSON.stringify(payload.request),
      signal: abortController.signal,
    });
    const responseHeaders = Object.fromEntries(upstream.headers.entries());
    const bodyText = await upstream.text();
    return sendEncryptedJson(res, envelope.id, {
      type: "compact_response",
      status: upstream.status,
      headers: responseHeaders,
      bodyText,
    });
  } catch (error) {
    if (abortController.signal.aborted || res.destroyed || res.writableEnded) return;
    return sendEncryptedJson(res, envelope.id, {
      type: "compact_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function streamEncryptedCodex(req, res) {
  let envelope;
  let payload;
  try {
    envelope = validateRequestEnvelope(await readJsonBody(req));
    payload = validateEncryptedPayload(
      openJson(e2eeRequestKey, requestAad("stream", envelope.id, envelope.timestamp), envelope),
    );
    acceptRequestId(envelope.id, Date.now());
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    return sendJson(res, status, {
      error: status === 409 ? "Encrypted request replay rejected" : "Invalid encrypted request",
    });
  }

  const abortController = new AbortController();
  attachDisconnectAbort(req, res, abortController);
  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });

  let sequence = 0;
  let terminal = false;
  try {
    const model = modelRegistry.find(PROVIDER, payload.modelId);
    if (!model) throw new Error(`Unsupported Codex model: ${payload.modelId}`);
    const { accessToken } = await getCodexAuth();
    const options = {
      ...sanitizeRemoteOptions(payload.options),
      apiKey: accessToken,
      signal: abortController.signal,
      onPayload: async (body) => {
        await writeEncryptedFrame(res, envelope.id, sequence++, {
          type: "request_template",
          model: payload.modelId,
          fields: extractCompactRequestTemplate(body),
        });
        return payload.nativeReplay ? applyNativeReplayPlan(body, payload.nativeReplay) : body;
      },
    };

    const upstreamStream = streamCodex(model, restoreInnerContext(payload.context), options);
    for await (const event of upstreamStream) {
      await writeEncryptedFrame(res, envelope.id, sequence++, compactAssistantEvent(event));
      if (event.type === "done" || event.type === "error") {
        terminal = true;
        break;
      }
    }
    if (!terminal) throw new Error("Codex provider stream ended without a terminal event");
    res.end();
  } catch (error) {
    if (abortController.signal.aborted || res.destroyed || res.writableEnded) return;
    try {
      await writeEncryptedFrame(res, envelope.id, sequence++, {
        type: "fatal",
        message: error instanceof Error ? error.message : String(error),
      });
      res.end();
    } catch {
      res.destroy();
    }
  }
}

const requestHandler = async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        protocol: E2EE_VERSION,
        nativeCompaction: true,
      });
    }

    if (req.method === "POST" && url.pathname === "/e2ee/v1/stream") {
      return await streamEncryptedCodex(req, res);
    }

    if (req.method === "POST" && url.pathname === "/e2ee/v1/compact") {
      return await encryptedCompact(req, res);
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    if (!res.headersSent) {
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(res, status, { error: status >= 500 ? "Relay request failed" : error.message });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
};

const server = http.createServer(requestHandler);

server.listen(PORT, HOST, () => {
  console.log(`Codex E2EE relay listening on http://${HOST}:${PORT}`);
  console.log(`E2EE stream endpoint: http://${HOST}:${PORT}/e2ee/v1/stream`);
  console.log(`E2EE native compaction endpoint: http://${HOST}:${PORT}/e2ee/v1/compact`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
