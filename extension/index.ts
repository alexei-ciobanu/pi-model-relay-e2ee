import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  RELAY_API,
  RELAY_PROVIDER,
  type RelayCatalog,
  type RelayCatalogModel,
  validateRelayCatalog,
} from "../shared/catalog.js";
import { deriveKey, E2EE_VERSION, loadMasterKey, openJson, requestAad, responseAad, sealJson } from "../shared/e2ee.js";

const MAX_ENCRYPTED_FRAME_BYTES = 64 * 1024 * 1024;
const CATALOG_TTL_MS = 4 * 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 10_000;
const TRANSPORT_REGISTRY = Symbol.for("alexei-ciobanu.pi-openai-compaction.transport-registry.v1");

// The authenticated wire protocol is validated event-by-event before values reach Pi.
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON frames intentionally have provider-defined fields
type JsonObject = Record<string, any>;

type NativeReplayPlan =
  | { version: 2; mode: "replace"; model: string; compactedWindow: unknown[]; liveTail: unknown[] }
  | { version: 2; mode: "inject"; model: string; compactedWindow: unknown[] };

type CompactTransportResponse = { status: number; headers?: Record<string, string>; bodyText: string };

type CompactionTransportAdapter = {
  id: string;
  provider: string;
  resolveModel(model: string):
    | {
        apiFamily: "openai-responses" | "openai-codex-responses";
        replayPolicy: "canonical-window" | "xai-compaction-head" | "codex-fresh-context";
      }
    | undefined;
  executeCompact(args: {
    model: string;
    request: JsonObject;
    signal: AbortSignal;
    sessionId?: string;
    clientRequestId?: string;
  }): Promise<CompactTransportResponse>;
  setReplayPlan(sessionId: string, plan: NativeReplayPlan | undefined): void;
};

type CompactionTransportRegistry = { adapters: Map<string, CompactionTransportAdapter> };

type CatalogCache = {
  baseUrl: string;
  checkedAt: number;
  catalog: RelayCatalog;
};

function compactionTransportRegistry(): CompactionTransportRegistry {
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
  let registry = globals[TRANSPORT_REGISTRY] as CompactionTransportRegistry | undefined;
  if (!registry) {
    registry = { adapters: new Map() };
    globals[TRANSPORT_REGISTRY] = registry;
  }
  return registry;
}

function remoteOptions(options?: SimpleStreamOptions): JsonObject {
  const output: JsonObject = {};
  if (!options) return output;
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
    const value = (options as JsonObject)[key];
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function rewriteMessage(message: AssistantMessage, model: Model<Api>): AssistantMessage {
  const source = {
    provider: message.provider,
    api: message.api,
    model: message.model,
  };
  return {
    ...message,
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: message.content.map((block) => ({ ...block })),
    piRelaySource: source,
  } as AssistantMessage;
}

function makeError(model: Model<Api>, error: unknown, partial?: AssistantMessage): AssistantMessage {
  const message = error instanceof Error ? error.message : String(error);
  if (partial) {
    return { ...rewriteMessage(partial, model), stopReason: "error", errorMessage: message };
  }
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

function setBlock(partial: AssistantMessage, index: number, block: JsonObject): void {
  if (!Number.isSafeInteger(index) || index < 0 || index > partial.content.length) {
    throw new Error(`Invalid encrypted content index: ${index}`);
  }
  partial.content[index] = block as AssistantMessage["content"][number];
}

function applyWireEvent(
  wire: JsonObject,
  model: Model<Api>,
  stream: AssistantMessageEventStream,
  state: { partial?: AssistantMessage; terminal: boolean },
  onRequestTemplate?: (model: string, fields: JsonObject) => void,
): void {
  if (!wire || typeof wire !== "object" || typeof wire.type !== "string") {
    throw new Error("Invalid encrypted stream event");
  }

  if (wire.type === "request_template") {
    if (
      typeof wire.model !== "string" ||
      !wire.fields ||
      typeof wire.fields !== "object" ||
      Array.isArray(wire.fields)
    ) {
      throw new Error("Invalid encrypted request-template event");
    }
    onRequestTemplate?.(wire.model, wire.fields);
    return;
  }

  if (wire.type === "fatal") {
    const error = makeError(
      model,
      typeof wire.message === "string" ? wire.message : "Pi model relay failed",
      state.partial,
    );
    state.terminal = true;
    stream.push({ type: "error", reason: "error", error });
    return;
  }

  if (wire.type === "start") {
    if (state.partial) throw new Error("Duplicate encrypted start event");
    state.partial = rewriteMessage(wire.partial as AssistantMessage, model);
    stream.push({ type: "start", partial: state.partial });
    return;
  }

  if (wire.type === "done") {
    const message = rewriteMessage(wire.message as AssistantMessage, model);
    state.partial = message;
    state.terminal = true;
    stream.push({ type: "done", reason: wire.reason, message });
    return;
  }

  if (wire.type === "error") {
    const error = rewriteMessage(wire.error as AssistantMessage, model);
    state.partial = error;
    state.terminal = true;
    stream.push({ type: "error", reason: wire.reason, error });
    return;
  }

  const partial = state.partial;
  if (!partial) throw new Error(`Encrypted ${wire.type} event arrived before start`);
  const contentIndex = wire.contentIndex;

  if (wire.type === "text_start") {
    setBlock(
      partial,
      contentIndex,
      wire.block?.type === "text" ? { ...wire.block, text: "" } : { type: "text", text: "" },
    );
    stream.push({ type: "text_start", contentIndex, partial });
  } else if (wire.type === "text_delta") {
    const block = partial.content[contentIndex];
    if (block?.type !== "text" || typeof wire.delta !== "string") throw new Error("Invalid encrypted text delta");
    block.text += wire.delta;
    stream.push({ type: "text_delta", contentIndex, delta: wire.delta, partial });
  } else if (wire.type === "text_end") {
    const block = wire.block?.type === "text" ? wire.block : { type: "text", text: wire.content };
    setBlock(partial, contentIndex, { ...block });
    stream.push({ type: "text_end", contentIndex, content: wire.content, partial });
  } else if (wire.type === "thinking_start") {
    setBlock(
      partial,
      contentIndex,
      wire.block?.type === "thinking" ? { ...wire.block, thinking: "" } : { type: "thinking", thinking: "" },
    );
    stream.push({ type: "thinking_start", contentIndex, partial });
  } else if (wire.type === "thinking_delta") {
    const block = partial.content[contentIndex];
    if (block?.type !== "thinking" || typeof wire.delta !== "string") {
      throw new Error("Invalid encrypted thinking delta");
    }
    block.thinking += wire.delta;
    stream.push({ type: "thinking_delta", contentIndex, delta: wire.delta, partial });
  } else if (wire.type === "thinking_end") {
    const block = wire.block?.type === "thinking" ? wire.block : { type: "thinking", thinking: wire.content };
    setBlock(partial, contentIndex, { ...block });
    stream.push({ type: "thinking_end", contentIndex, content: wire.content, partial });
  } else if (wire.type === "toolcall_start") {
    setBlock(
      partial,
      contentIndex,
      wire.block?.type === "toolCall"
        ? { ...wire.block, arguments: wire.block.arguments ?? {} }
        : { type: "toolCall", id: "", name: "", arguments: {} },
    );
    stream.push({ type: "toolcall_start", contentIndex, partial });
  } else if (wire.type === "toolcall_delta") {
    if (typeof wire.delta !== "string") throw new Error("Invalid encrypted tool-call delta");
    stream.push({ type: "toolcall_delta", contentIndex, delta: wire.delta, partial });
  } else if (wire.type === "toolcall_end") {
    setBlock(partial, contentIndex, { ...wire.toolCall });
    stream.push({ type: "toolcall_end", contentIndex, toolCall: wire.toolCall, partial });
  } else {
    throw new Error(`Unknown encrypted stream event: ${wire.type}`);
  }
}

function encryptedStream(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  baseUrl: string,
  keyPath: string,
  nativeReplay: NativeReplayPlan | undefined,
  onRequestTemplate?: (model: string, fields: JsonObject) => void,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const state: { partial?: AssistantMessage; terminal: boolean } = { terminal: false };
    try {
      const masterKey = loadMasterKey(keyPath);
      const requestKey = deriveKey(masterKey, "request");
      const responseKey = deriveKey(masterKey, "response");
      const id = randomUUID();
      const timestamp = Date.now();
      const sealed = sealJson(requestKey, requestAad("stream", id, timestamp), {
        modelId: model.id,
        context,
        options: remoteOptions(options),
        ...(nativeReplay ? { nativeReplay } : {}),
      });

      const response = await fetch(`${baseUrl}/e2ee/v2/stream`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: E2EE_VERSION, id, timestamp, ...sealed }),
        signal: options?.signal,
      });
      await options?.onResponse?.(
        { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
        model,
      );
      if (!response.ok) {
        const body = (await response.text()).slice(0, 1024);
        throw new Error(`Pi model E2EE relay returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
      }
      if (!response.body) throw new Error("Pi model E2EE relay returned no response body");

      const decoder = new TextDecoder();
      let buffered = "";
      let expectedSequence = 0;

      const processLine = (line: string) => {
        if (!line) return;
        if (Buffer.byteLength(line, "utf8") > MAX_ENCRYPTED_FRAME_BYTES) {
          throw new Error("Encrypted response frame is too large");
        }
        const frame = JSON.parse(line) as JsonObject;
        if (frame.v !== E2EE_VERSION || frame.id !== id || frame.sequence !== expectedSequence) {
          throw new Error("Encrypted response frame identity or sequence mismatch");
        }
        const wire = openJson(responseKey, responseAad("stream", id, expectedSequence), frame) as JsonObject;
        expectedSequence++;
        applyWireEvent(wire, model, stream, state, onRequestTemplate);
      };

      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const line = buffered.slice(0, newline).replace(/\r$/, "");
          buffered = buffered.slice(newline + 1);
          processLine(line);
          newline = buffered.indexOf("\n");
        }
      }
      buffered += decoder.decode();
      if (buffered.trim()) processLine(buffered.replace(/\r$/, ""));
      if (!state.terminal) throw new Error("Encrypted response stream ended without an authenticated terminal frame");
    } catch (error) {
      if (!state.terminal) {
        const aborted = options?.signal?.aborted === true;
        const message = makeError(model, error, state.partial);
        message.stopReason = aborted ? "aborted" : "error";
        state.terminal = true;
        stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
      }
    } finally {
      stream.end();
    }
  })();

  return stream;
}

async function executeEncryptedCompact(args: {
  baseUrl: string;
  keyPath: string;
  model: string;
  request: JsonObject;
  signal: AbortSignal;
  sessionId?: string;
  clientRequestId?: string;
}): Promise<CompactTransportResponse> {
  const masterKey = loadMasterKey(args.keyPath);
  const requestKey = deriveKey(masterKey, "request");
  const responseKey = deriveKey(masterKey, "response");
  const id = randomUUID();
  const timestamp = Date.now();
  const sealed = sealJson(requestKey, requestAad("compact", id, timestamp), {
    modelId: args.model,
    request: args.request,
    sessionId: args.sessionId,
    clientRequestId: args.clientRequestId,
  });
  const response = await fetch(`${args.baseUrl}/e2ee/v2/compact`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: E2EE_VERSION, id, timestamp, ...sealed }),
    signal: args.signal,
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Pi model E2EE compact relay returned HTTP ${response.status}`);
  const frame = JSON.parse(responseText) as JsonObject;
  if (frame.v !== E2EE_VERSION || frame.id !== id || frame.sequence !== 0) {
    throw new Error("Encrypted compact response identity mismatch");
  }
  const wire = openJson(responseKey, responseAad("compact", id, 0), frame) as JsonObject;
  if (wire.type === "compact_error") {
    throw new Error(typeof wire.message === "string" ? wire.message : "Pi model E2EE compact relay failed");
  }
  if (
    wire.type !== "compact_response" ||
    !Number.isInteger(wire.status) ||
    typeof wire.bodyText !== "string" ||
    (wire.headers !== undefined && (!wire.headers || typeof wire.headers !== "object" || Array.isArray(wire.headers)))
  ) {
    throw new Error("Invalid encrypted compact response");
  }
  return { status: wire.status, headers: wire.headers, bodyText: wire.bodyText };
}

async function fetchCatalog(args: {
  baseUrl: string;
  keyPath: string;
  signal?: AbortSignal;
  force?: boolean;
}): Promise<RelayCatalog> {
  const masterKey = loadMasterKey(args.keyPath);
  const requestKey = deriveKey(masterKey, "request");
  const responseKey = deriveKey(masterKey, "response");
  const id = randomUUID();
  const timestamp = Date.now();
  const sealed = sealJson(requestKey, requestAad("models", id, timestamp), { force: args.force === true });
  const timeoutSignal = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  const signal = args.signal ? AbortSignal.any([args.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`${args.baseUrl}/e2ee/v2/models`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: E2EE_VERSION, id, timestamp, ...sealed }),
    signal,
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Pi model catalog relay returned HTTP ${response.status}`);
  if (Buffer.byteLength(responseText, "utf8") > MAX_ENCRYPTED_FRAME_BYTES) {
    throw new Error("Encrypted model catalog response is too large");
  }
  const frame = JSON.parse(responseText) as JsonObject;
  if (frame.v !== E2EE_VERSION || frame.id !== id || frame.sequence !== 0) {
    throw new Error("Encrypted model catalog response identity mismatch");
  }
  const wire = openJson(responseKey, responseAad("models", id, 0), frame) as JsonObject;
  if (wire.type === "models_error") {
    throw new Error(typeof wire.message === "string" ? wire.message : "Pi model catalog relay failed");
  }
  if (wire.type !== "models_response") throw new Error("Invalid encrypted model catalog response");
  return validateRelayCatalog(wire.catalog);
}

async function readCatalogCache(path: string, baseUrl: string): Promise<CatalogCache | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<CatalogCache>;
    if (
      value.baseUrl !== baseUrl ||
      typeof value.checkedAt !== "number" ||
      !Number.isSafeInteger(value.checkedAt) ||
      !value.catalog
    ) {
      return undefined;
    }
    return {
      baseUrl,
      checkedAt: value.checkedAt,
      catalog: validateRelayCatalog(value.catalog),
    };
  } catch {
    return undefined;
  }
}

async function writeCatalogCache(path: string, value: CatalogCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

function toProviderModels(catalog: RelayCatalog | undefined): ProviderModelConfig[] {
  return (catalog?.models ?? []).map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    input: [...model.input],
    cost: structuredClone(model.cost),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
}

export default async function (pi: ExtensionAPI) {
  const configuredUrl = process.env.PI_MODEL_RELAY_URL || "http://127.0.0.1:8787";
  const parsedUrl = new URL(configuredUrl);
  if (
    !/^https?:$/.test(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error("PI_MODEL_RELAY_URL must be an HTTP(S) origin without credentials, query, or fragment");
  }
  const baseUrl = parsedUrl.toString().replace(/\/$/, "");
  const configDir = join(homedir(), ".config", "pi-model-relay-e2ee");
  const keyPath = process.env.PI_MODEL_RELAY_KEY_FILE || join(configDir, "key");
  const cachePath = process.env.PI_MODEL_RELAY_MODELS_CACHE_FILE || join(configDir, "models-cache.json");

  let cache = await readCatalogCache(cachePath, baseUrl);
  let catalog = cache?.catalog;
  let catalogError: string | undefined;
  if (!cache || Date.now() - cache.checkedAt >= CATALOG_TTL_MS) {
    try {
      catalog = await fetchCatalog({ baseUrl, keyPath });
      cache = { baseUrl, checkedAt: Date.now(), catalog };
      await writeCatalogCache(cachePath, cache);
    } catch (error) {
      catalogError = error instanceof Error ? error.message : String(error);
    }
  }

  const replayPlans = new Map<string, NativeReplayPlan>();
  const requestTemplates = new Map<string, { model: string; fields: JsonObject }>();
  const catalogModel = (modelId: string): RelayCatalogModel | undefined =>
    catalog?.models.find((model) => model.id === modelId);
  const adapter: CompactionTransportAdapter = {
    id: "pi-model-relay-e2ee-native-compaction-v2",
    provider: RELAY_PROVIDER,
    resolveModel(model) {
      const support = catalogModel(model)?.nativeCompaction;
      return support ? { ...support } : undefined;
    },
    async executeCompact(args) {
      const template = args.sessionId ? requestTemplates.get(args.sessionId) : undefined;
      const request =
        template?.model === args.model ? { ...args.request, ...structuredClone(template.fields) } : { ...args.request };
      return executeEncryptedCompact({
        baseUrl,
        keyPath,
        model: args.model,
        request,
        signal: args.signal,
        sessionId: args.sessionId,
        clientRequestId: args.clientRequestId,
      });
    },
    setReplayPlan(sessionId, plan) {
      if (plan) replayPlans.set(sessionId, structuredClone(plan));
      else replayPlans.delete(sessionId);
    },
  };
  compactionTransportRegistry().adapters.set(RELAY_PROVIDER, adapter);

  pi.registerProvider(RELAY_PROVIDER, {
    name: "Pi Model E2EE Relay",
    baseUrl,
    apiKey: "e2ee-psk",
    api: RELAY_API,
    models: toProviderModels(catalog),
    async refreshModels(context) {
      const stored = await readCatalogCache(cachePath, baseUrl);
      if (stored && (!catalog || stored.catalog.revision !== catalog.revision)) {
        cache = stored;
        catalog = stored.catalog;
      }
      if (!context.allowNetwork) return toProviderModels(catalog);
      if (!context.force && cache && Date.now() - cache.checkedAt < CATALOG_TTL_MS) {
        return toProviderModels(catalog);
      }
      try {
        const refreshed = await fetchCatalog({ baseUrl, keyPath, signal: context.signal, force: context.force });
        catalog = refreshed;
        cache = { baseUrl, checkedAt: Date.now(), catalog: refreshed };
        await writeCatalogCache(cachePath, cache);
        catalogError = undefined;
        return toProviderModels(refreshed);
      } catch (error) {
        catalogError = error instanceof Error ? error.message : String(error);
        if (catalog) return toProviderModels(catalog);
        throw error;
      }
    },
    streamSimple: (model, context, options) => {
      const sessionId = options?.sessionId;
      const nativeReplay = sessionId ? replayPlans.get(sessionId) : undefined;
      if (sessionId) replayPlans.delete(sessionId);
      return encryptedStream(model, context, options, baseUrl, keyPath, nativeReplay, (templateModel, fields) => {
        if (sessionId) requestTemplates.set(sessionId, { model: templateModel, fields: structuredClone(fields) });
      });
    },
  });

  pi.on("session_start", (_event, ctx) => {
    try {
      loadMasterKey(keyPath);
      if (catalogError && ctx.hasUI) ctx.ui.notify(`pi-model-relay-e2ee: ${catalogError}`, "warning");
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(`pi-model-relay-e2ee: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  });

  pi.on("session_shutdown", () => {
    replayPlans.clear();
    requestTemplates.clear();
    const registry = compactionTransportRegistry();
    if (registry.adapters.get(RELAY_PROVIDER) === adapter) registry.adapters.delete(RELAY_PROVIDER);
  });
}
