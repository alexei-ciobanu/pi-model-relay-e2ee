#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createRelayCatalog,
  nativeCompactionSupport,
  parseRelayModelId,
  RELAY_API,
  RELAY_PROVIDER,
} from "../../shared/catalog.js";
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
import { createRelayModelRuntimeManager } from "./model-runtime.js";
import {
  applyCodexRemoteCompactionHeaders,
  applyNativeReplayPlan,
  buildCompactUrl,
  executeCodexRemoteCompactionRequest,
  extractCompactRequestTemplate,
  validateCompactPayload,
  validateNativeReplayPlan,
} from "./native-compaction.js";

const HOST = process.env.PI_MODEL_RELAY_HOST || "127.0.0.1";
const PORT = Number(process.env.PI_MODEL_RELAY_PORT || "8787");
const MAX_BODY_BYTES = Number(process.env.PI_MODEL_RELAY_MAX_BODY_BYTES || 50 * 1024 * 1024);
const KEY_FILE = process.env.PI_MODEL_RELAY_KEY_FILE || join(homedir(), ".config", "pi-model-relay-e2ee", "key");
const REPLAY_TTL_MS = 2 * 60_000;
const MAX_ENCRYPTED_FRAME_BYTES = 64 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveCodexInstallationId() {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  try {
    const installationId = readFileSync(join(codexHome, "installation_id"), "utf8").trim();
    if (UUID_RE.test(installationId)) return installationId.toLowerCase();
  } catch {
    // This identity header is a parity hint; a process-local UUID is a safe fallback.
  }
  return randomUUID();
}

const CODEX_INSTALLATION_ID = resolveCodexInstallationId();

function parseCsvSet(value) {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries?.length ? new Set(entries) : undefined;
}

const allowedProviders = parseCsvSet(process.env.PI_MODEL_RELAY_ALLOW_PROVIDERS);
const allowedModels = parseCsvSet(process.env.PI_MODEL_RELAY_ALLOW_MODELS);

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
  configurationError(`Invalid PI_MODEL_RELAY_PORT: ${process.env.PI_MODEL_RELAY_PORT || ""}`);
}
if (!Number.isSafeInteger(MAX_BODY_BYTES) || MAX_BODY_BYTES < 1) {
  configurationError(`Invalid PI_MODEL_RELAY_MAX_BODY_BYTES: ${process.env.PI_MODEL_RELAY_MAX_BODY_BYTES || ""}`);
}

let e2eeRequestKey;
let e2eeResponseKey;
try {
  const masterKey = loadMasterKey(KEY_FILE);
  e2eeRequestKey = deriveKey(masterKey, "request");
  e2eeResponseKey = deriveKey(masterKey, "response");
} catch (error) {
  configurationError(
    `Could not load PI_MODEL_RELAY_KEY_FILE (${KEY_FILE}): ${error instanceof Error ? error.message : String(error)}`,
  );
}

const runtimeManager = createRelayModelRuntimeManager();
const replayCache = new Map();

function isModelAllowed(model) {
  if (model.provider === RELAY_PROVIDER) return false;
  if (allowedProviders && !allowedProviders.has(model.provider)) return false;
  const relayId = `${model.provider}/${model.id}`;
  return !allowedModels || allowedModels.has(relayId);
}

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

function pruneReplayCache(now) {
  for (const [id, expires] of replayCache) if (expires <= now) replayCache.delete(id);
}

function acceptRequestId(id, now) {
  pruneReplayCache(now);
  if (replayCache.has(id)) throw new HttpError(409, "Encrypted request replay rejected");
  replayCache.set(id, now + REPLAY_TTL_MS);
}

async function readEncryptedRequest(req, operation) {
  const envelope = validateRequestEnvelope(await readJsonBody(req));
  const payload = openJson(e2eeRequestKey, requestAad(operation, envelope.id, envelope.timestamp), envelope);
  acceptRequestId(envelope.id, Date.now());
  return { envelope, payload };
}

function sendEncryptedJson(res, operation, id, wireValue) {
  const sealed = sealJson(e2eeResponseKey, responseAad(operation, id, 0), wireValue);
  sendJson(res, 200, { v: E2EE_VERSION, id, sequence: 0, ...sealed });
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

async function writeEncryptedFrame(res, id, sequence, wireEvent) {
  const sealed = sealJson(e2eeResponseKey, responseAad("stream", id, sequence), wireEvent);
  const frame = JSON.stringify({ v: E2EE_VERSION, id, sequence, ...sealed });
  if (Buffer.byteLength(frame, "utf8") > MAX_ENCRYPTED_FRAME_BYTES) {
    throw new Error("Encrypted response frame is too large");
  }
  await writeWithBackpressure(res, `${frame}\n`);
}

function validateStreamPayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Invalid encrypted stream request");
  if (typeof payload.modelId !== "string" || !payload.modelId) throw new Error("Invalid encrypted stream request");
  if (!payload.context || typeof payload.context !== "object" || !Array.isArray(payload.context.messages)) {
    throw new Error("Invalid encrypted stream request");
  }
  if (
    payload.options !== undefined &&
    (!payload.options || typeof payload.options !== "object" || Array.isArray(payload.options))
  ) {
    throw new Error("Invalid encrypted stream request");
  }
  if (payload.nativeReplay !== undefined) {
    validateNativeReplayPlan(payload.nativeReplay, payload.modelId);
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

function compactAssistantEvent(event) {
  if (event.type === "start" || event.type === "done" || event.type === "error") return event;
  const compact = { ...event };
  delete compact.partial;
  if (event.type.endsWith("_start") || event.type === "text_end" || event.type === "thinking_end") {
    compact.block = event.partial?.content?.[event.contentIndex];
  }
  return compact;
}

function resolveRelayModel(runtime, relayModelId) {
  const route = parseRelayModelId(relayModelId);
  if (!route) throw new Error(`Invalid relay model id: ${relayModelId}`);
  const model = runtime.getModel(route.provider, route.modelId);
  if (!model || !isModelAllowed(model)) throw new Error(`Relay model is not available: ${relayModelId}`);
  return model;
}

function restoreInnerContext(context, runtime) {
  return {
    ...context,
    messages: context.messages.map((message) => {
      if (message?.role !== "assistant" || message.provider !== RELAY_PROVIDER || message.api !== RELAY_API) {
        return message;
      }
      const source = message.piRelaySource;
      const route = parseRelayModelId(message.model);
      const model = route ? runtime.getModel(route.provider, route.modelId) : undefined;
      const provider = typeof source?.provider === "string" ? source.provider : model?.provider;
      const api = typeof source?.api === "string" ? source.api : model?.api;
      const modelId = typeof source?.model === "string" ? source.model : model?.id;
      if (!provider || !api || !modelId) throw new Error(`Cannot restore relayed assistant model: ${message.model}`);
      const { piRelaySource: _source, ...restored } = message;
      return { ...restored, provider, api, model: modelId };
    }),
  };
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function accountIdFromJwt(token) {
  try {
    const [, payload] = token.split(".");
    if (!payload) return undefined;
    const json = JSON.parse(decodeBase64Url(payload));
    return json?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

async function buildCompactTarget(runtime, model, support, payload) {
  const resolution = await runtime.getAuth(model);
  if (!resolution) throw new Error(`No Pi authentication configured for ${model.provider}`);
  const headers = new Headers(model.headers ?? {});
  for (const [key, value] of Object.entries(resolution.auth.headers ?? {})) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  if (resolution.auth.apiKey) headers.set("authorization", `Bearer ${resolution.auth.apiKey}`);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  headers.set("user-agent", "pi-model-relay-e2ee");
  const clientRequestId = String(payload.clientRequestId || payload.sessionId || `pi-compact-${randomUUID()}`);
  headers.set("x-client-request-id", clientRequestId);
  if (payload.sessionId) headers.set("session_id", String(payload.sessionId));

  if (support.apiFamily === "openai-codex-responses") {
    const accountId = accountIdFromJwt(resolution.auth.apiKey ?? "");
    if (!accountId) throw new Error("Could not determine ChatGPT accountId from Pi OAuth token");
    headers.set("chatgpt-account-id", accountId);
    headers.set("originator", "pi");
    headers.set("openai-beta", "responses=experimental");
    applyCodexRemoteCompactionHeaders(headers, {
      installationId: CODEX_INSTALLATION_ID,
      sessionId: payload.sessionId,
    });
  }

  const baseUrl = resolution.auth.baseUrl ?? model.baseUrl;
  return { url: buildCompactUrl(baseUrl, support.apiFamily), headers };
}

async function encryptedModels(req, res) {
  let envelope;
  try {
    const decoded = await readEncryptedRequest(req, "models");
    envelope = decoded.envelope;
    const payload = decoded.payload;
    if (
      !payload ||
      typeof payload !== "object" ||
      (payload.force !== undefined && typeof payload.force !== "boolean")
    ) {
      throw new Error("Invalid encrypted models request");
    }
    const runtime = await runtimeManager.getRuntime();
    await runtime.refresh({ allowNetwork: true, force: payload.force === true });
    const models = (await runtime.getAvailable()).filter(isModelAllowed);
    return sendEncryptedJson(res, "models", envelope.id, {
      type: "models_response",
      catalog: createRelayCatalog(models),
    });
  } catch (error) {
    if (envelope) {
      return sendEncryptedJson(res, "models", envelope.id, {
        type: "models_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const status = error instanceof HttpError ? error.status : 400;
    return sendJson(res, status, { error: status === 409 ? error.message : "Invalid encrypted request" });
  }
}

async function encryptedCompact(req, res) {
  let envelope;
  let payload;
  try {
    const decoded = await readEncryptedRequest(req, "compact");
    envelope = decoded.envelope;
    payload = validateCompactPayload(decoded.payload);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    return sendJson(res, status, { error: status === 409 ? error.message : "Invalid encrypted request" });
  }

  const abortController = new AbortController();
  attachDisconnectAbort(req, res, abortController);
  try {
    const runtime = await runtimeManager.getRuntime();
    const model = resolveRelayModel(runtime, payload.modelId);
    const support = nativeCompactionSupport(model);
    if (!support) throw new Error(`Native compaction is unsupported for ${payload.modelId}`);
    const target = await buildCompactTarget(runtime, model, support, payload);
    const codexRemoteV2 = support.apiFamily === "openai-codex-responses";
    let upstreamResult;
    if (codexRemoteV2) {
      upstreamResult = await executeCodexRemoteCompactionRequest({
        fetchImpl: fetch,
        url: target.url,
        headers: target.headers,
        request: payload.request,
        modelId: model.id,
        sessionId: payload.sessionId,
        signal: abortController.signal,
      });
    } else {
      const request = { ...payload.request, model: model.id };
      const upstream = await fetch(target.url, {
        method: "POST",
        headers: target.headers,
        body: JSON.stringify(request),
        signal: abortController.signal,
      });
      upstreamResult = {
        status: upstream.status,
        headers: Object.fromEntries(upstream.headers.entries()),
        bodyText: await upstream.text(),
      };
    }
    return sendEncryptedJson(res, "compact", envelope.id, {
      type: "compact_response",
      status: upstreamResult.status,
      headers: upstreamResult.headers,
      bodyText: upstreamResult.bodyText,
    });
  } catch (error) {
    if (abortController.signal.aborted || res.destroyed || res.writableEnded) return;
    return sendEncryptedJson(res, "compact", envelope.id, {
      type: "compact_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function streamEncryptedModel(req, res) {
  let envelope;
  let payload;
  try {
    const decoded = await readEncryptedRequest(req, "stream");
    envelope = decoded.envelope;
    payload = validateStreamPayload(decoded.payload);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    return sendJson(res, status, { error: status === 409 ? error.message : "Invalid encrypted request" });
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
    const runtime = await runtimeManager.getRuntime();
    const model = resolveRelayModel(runtime, payload.modelId);
    const support = nativeCompactionSupport(model);
    if (payload.nativeReplay && !support) throw new Error(`Native replay is unsupported for ${payload.modelId}`);
    const options = {
      ...sanitizeRemoteOptions(payload.options),
      signal: abortController.signal,
      onPayload: async (body) => {
        if (support) {
          await writeEncryptedFrame(res, envelope.id, sequence++, {
            type: "request_template",
            model: payload.modelId,
            fields: extractCompactRequestTemplate(body),
          });
        }
        if (!payload.nativeReplay) return body;
        return applyNativeReplayPlan(body, { ...payload.nativeReplay, model: model.id }, support?.replayPolicy);
      },
    };

    const upstreamStream = runtime.streamSimple(model, restoreInnerContext(payload.context, runtime), options);
    for await (const event of upstreamStream) {
      await writeEncryptedFrame(res, envelope.id, sequence++, compactAssistantEvent(event));
      if (event.type === "done" || event.type === "error") {
        terminal = true;
        break;
      }
    }
    if (!terminal) throw new Error("Pi provider stream ended without a terminal event");
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
        provider: RELAY_PROVIDER,
        encryptedModels: true,
        nativeCompaction: true,
        nativeCompactionProtocols: { codex: "responses_compaction_v2" },
      });
    }
    if (req.method === "POST" && url.pathname === "/e2ee/v2/models") return encryptedModels(req, res);
    if (req.method === "POST" && url.pathname === "/e2ee/v2/stream") return streamEncryptedModel(req, res);
    if (req.method === "POST" && url.pathname === "/e2ee/v2/compact") return encryptedCompact(req, res);
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
  console.log(`Pi model E2EE relay listening on http://${HOST}:${PORT}`);
  console.log(`Encrypted model catalog: http://${HOST}:${PORT}/e2ee/v2/models`);
  console.log(`Encrypted stream endpoint: http://${HOST}:${PORT}/e2ee/v2/stream`);
  console.log(`Encrypted compaction endpoint: http://${HOST}:${PORT}/e2ee/v2/compact`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
