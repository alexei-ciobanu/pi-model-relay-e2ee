import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const RELAY_PROVIDER: "pi-relay-e2ee";
export const RELAY_API: "pi-model-relay-e2ee-v2";
export const CATALOG_VERSION: 2;

export type NativeCompactionSupport = {
  apiFamily: "openai-responses" | "openai-codex-responses";
  replayPolicy: "canonical-window" | "xai-compaction-head" | "codex-fresh-context";
};

export type RelayCatalogModel = {
  id: string;
  name: string;
  sourceProvider: string;
  sourceModel: string;
  sourceApi: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: Model<Api>["cost"];
  contextWindow: number;
  maxTokens: number;
  nativeCompaction?: NativeCompactionSupport;
};

export type RelayCatalog = {
  version: 2;
  revision: string;
  generatedAt: string;
  models: RelayCatalogModel[];
};

export function createRelayModelId(provider: string, modelId: string): string;
export function parseRelayModelId(relayModelId: string): { provider: string; modelId: string } | undefined;
export function nativeCompactionSupport(model: Model<Api>): NativeCompactionSupport | undefined;
export function toRelayCatalogModel(model: Model<Api>): RelayCatalogModel;
export function createRelayCatalog(models: readonly Model<Api>[]): RelayCatalog;
export function validateRelayCatalog(value: unknown): RelayCatalog;
