import { createHash } from "node:crypto";

export const RELAY_PROVIDER = "pi-relay-e2ee";
export const RELAY_API = "pi-model-relay-e2ee-v2";
export const CATALOG_VERSION = 2;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

export function createRelayModelId(provider, modelId) {
  if (typeof provider !== "string" || !provider || provider.includes("/")) {
    throw new Error(`Invalid upstream provider id: ${provider}`);
  }
  if (typeof modelId !== "string" || !modelId) throw new Error("Invalid upstream model id");
  return `${provider}/${modelId}`;
}

export function parseRelayModelId(relayModelId) {
  if (typeof relayModelId !== "string") return undefined;
  const separator = relayModelId.indexOf("/");
  if (separator <= 0 || separator === relayModelId.length - 1) return undefined;
  return {
    provider: relayModelId.slice(0, separator),
    modelId: relayModelId.slice(separator + 1),
  };
}

export function nativeCompactionSupport(model) {
  if (!model || typeof model !== "object") return undefined;
  if (model.provider !== "openai" && model.provider !== "openai-codex" && model.provider !== "xai") {
    return undefined;
  }
  let apiFamily;
  if (model.api === "openai-codex-responses") apiFamily = "openai-codex-responses";
  else if (model.api === "openai-responses" || model.api === "openai-websocket-responses") {
    apiFamily = model.provider === "openai-codex" ? "openai-codex-responses" : "openai-responses";
  }
  if (!apiFamily) return undefined;
  let replayPolicy = "canonical-window";
  if (model.provider === "xai") replayPolicy = "xai-compaction-head";
  else if (model.provider === "openai-codex") replayPolicy = "codex-fresh-context";
  return {
    apiFamily,
    replayPolicy,
  };
}

export function toRelayCatalogModel(model) {
  const id = createRelayModelId(model.provider, model.id);
  const nativeCompaction = nativeCompactionSupport(model);
  return {
    id,
    name: `${model.name} (${model.provider} via E2EE relay)`,
    sourceProvider: model.provider,
    sourceModel: model.id,
    sourceApi: model.api,
    reasoning: model.reasoning === true,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: clone(model.thinkingLevelMap) } : {}),
    input: [...model.input],
    cost: clone(model.cost),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(nativeCompaction ? { nativeCompaction } : {}),
  };
}

export function createRelayCatalog(models) {
  const catalogModels = models
    .filter((model) => model.provider !== RELAY_PROVIDER)
    .map(toRelayCatalogModel)
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set();
  for (const model of catalogModels) {
    if (ids.has(model.id)) throw new Error(`Duplicate relay model id: ${model.id}`);
    ids.add(model.id);
  }
  const revision = createHash("sha256").update(JSON.stringify(catalogModels)).digest("hex");
  return {
    version: CATALOG_VERSION,
    revision,
    generatedAt: new Date().toISOString(),
    models: catalogModels,
  };
}

function isCost(value) {
  return (
    isRecord(value) &&
    ["input", "output", "cacheRead", "cacheWrite"].every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0,
    )
  );
}

function isNativeCompaction(value) {
  return (
    isRecord(value) &&
    (value.apiFamily === "openai-responses" || value.apiFamily === "openai-codex-responses") &&
    (value.replayPolicy === "canonical-window" ||
      value.replayPolicy === "xai-compaction-head" ||
      value.replayPolicy === "codex-fresh-context")
  );
}

function isCatalogModel(value) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Boolean(parseRelayModelId(value.id)) &&
    typeof value.name === "string" &&
    typeof value.sourceProvider === "string" &&
    typeof value.sourceModel === "string" &&
    typeof value.sourceApi === "string" &&
    typeof value.reasoning === "boolean" &&
    Array.isArray(value.input) &&
    value.input.length > 0 &&
    value.input.every((entry) => entry === "text" || entry === "image") &&
    isCost(value.cost) &&
    Number.isSafeInteger(value.contextWindow) &&
    value.contextWindow > 0 &&
    Number.isSafeInteger(value.maxTokens) &&
    value.maxTokens > 0 &&
    (value.thinkingLevelMap === undefined || isRecord(value.thinkingLevelMap)) &&
    (value.nativeCompaction === undefined || isNativeCompaction(value.nativeCompaction))
  );
}

export function validateRelayCatalog(value) {
  if (
    !isRecord(value) ||
    value.version !== CATALOG_VERSION ||
    typeof value.revision !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.revision) ||
    typeof value.generatedAt !== "string" ||
    !Array.isArray(value.models) ||
    !value.models.every(isCatalogModel)
  ) {
    throw new Error("Invalid encrypted relay model catalog");
  }
  const ids = new Set();
  for (const model of value.models) {
    if (ids.has(model.id)) throw new Error(`Duplicate encrypted relay model id: ${model.id}`);
    ids.add(model.id);
  }
  return value;
}
