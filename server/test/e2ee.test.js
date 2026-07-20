import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRelayCatalog,
  createRelayModelId,
  nativeCompactionSupport,
  parseRelayModelId,
  validateRelayCatalog,
} from "../../shared/catalog.js";
import {
  deriveKey,
  E2EE_VERSION,
  openJson,
  requestAad,
  responseAad,
  sealJson,
  validateRequestEnvelope,
} from "../../shared/e2ee.js";
import { createRelayModelRuntimeManager } from "../src/model-runtime.js";
import {
  applyNativeReplayPlan,
  extractCompactRequestTemplate,
  validateCompactPayload,
  validateNativeReplayPlan,
} from "../src/native-compaction.js";

test("request and response keys are direction-separated", () => {
  const master = randomBytes(32);
  assert.notDeepEqual(deriveKey(master, "request"), deriveKey(master, "response"));
});

test("AES-GCM envelope round trips JSON", () => {
  const key = deriveKey(randomBytes(32), "request");
  const id = randomUUID();
  const timestamp = Date.now();
  const value = {
    modelId: "gpt-5.6-luna",
    context: { messages: [{ role: "user", content: "secret" }] },
  };
  const envelope = sealJson(key, requestAad("stream", id, timestamp), value);
  assert.deepEqual(openJson(key, requestAad("stream", id, timestamp), envelope), value);
});

test("tampering and frame reordering fail authentication", () => {
  const key = deriveKey(randomBytes(32), "response");
  const id = randomUUID();
  const envelope = sealJson(key, responseAad("stream", id, 0), {
    type: "text_delta",
    delta: "secret",
  });

  assert.throws(() => openJson(key, responseAad("stream", id, 1), envelope));
  assert.throws(() => openJson(key, responseAad("compact", id, 0), envelope));
  const replacement = envelope.ciphertext[0] === "A" ? "B" : "A";
  const tampered = {
    ...envelope,
    ciphertext: replacement + envelope.ciphertext.slice(1),
  };
  assert.throws(() => openJson(key, responseAad("stream", id, 0), tampered));
});

test("request envelope enforces version and clock window", () => {
  const now = Date.now();
  const valid = {
    v: E2EE_VERSION,
    id: randomUUID(),
    timestamp: now,
    nonce: "unused",
    ciphertext: "unused",
    tag: "unused",
  };
  assert.equal(validateRequestEnvelope(valid, now), valid);
  assert.throws(() => validateRequestEnvelope({ ...valid, v: 1 }, now));
  assert.throws(() => validateRequestEnvelope({ ...valid, timestamp: now - 120_000 }, now));
});

test("Codex native replay places fresh provider context after the compacted window", () => {
  const body = {
    model: "gpt-5.6-luna",
    input: [
      { role: "developer", content: "leading" },
      { role: "user", content: "placeholder" },
      { role: "developer", content: "trailing" },
    ],
  };
  const rewritten = applyNativeReplayPlan(
    body,
    {
      version: 2,
      mode: "replace",
      model: body.model,
      compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }],
      liveTail: [{ role: "user", content: "live tail" }],
    },
    "codex-fresh-context",
  );
  assert.deepEqual(rewritten.input, [
    { type: "compaction", encrypted_content: "opaque" },
    body.input[0],
    { role: "user", content: "live tail" },
    body.input[2],
  ]);
});

test("public OpenAI replay preserves the canonical window and removes fresh prompt envelopes", () => {
  const body = {
    model: "gpt-5.6",
    instructions: "fresh top-level instructions",
    input: [
      { role: "developer", content: "fresh leading envelope" },
      { role: "user", content: "placeholder" },
      { role: "developer", content: "fresh trailing envelope" },
    ],
  };
  const compactedWindow = [
    { type: "message", role: "user", content: "retained user item" },
    { type: "compaction", encrypted_content: "opaque-openai" },
  ];
  const rewritten = applyNativeReplayPlan(
    body,
    {
      version: 2,
      mode: "replace",
      model: body.model,
      compactedWindow,
      liveTail: [{ role: "user", content: "live tail" }],
    },
    "canonical-window",
  );

  assert.equal(rewritten.instructions, undefined);
  assert.deepEqual(rewritten.input, [...compactedWindow, { role: "user", content: "live tail" }]);
});

test("native replay injects an older opaque window into Pi fallback compaction", () => {
  const body = {
    model: "gpt-5.6-luna",
    input: [{ role: "user", content: "summarize this" }],
  };
  const rewritten = applyNativeReplayPlan(body, {
    version: 2,
    mode: "inject",
    model: body.model,
    compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }],
  });
  assert.deepEqual(rewritten.input, [{ type: "compaction", encrypted_content: "opaque" }, body.input[0]]);
});

test("stream protocol accepts version 2 native replay plans used after compaction", () => {
  const replacePlan = {
    version: 2,
    mode: "replace",
    model: "xai/grok-4.5",
    compactedWindow: [{ type: "compaction", encrypted_content: "opaque-xai" }],
    liveTail: [{ role: "user", content: "continue after compact" }],
  };
  const injectPlan = {
    version: 2,
    mode: "inject",
    model: "xai/grok-4.5",
    compactedWindow: [{ type: "compaction", encrypted_content: "opaque-xai" }],
  };

  assert.equal(validateNativeReplayPlan(replacePlan, "xai/grok-4.5"), replacePlan);
  assert.equal(validateNativeReplayPlan(injectPlan, "xai/grok-4.5"), injectPlan);
  assert.throws(() => validateNativeReplayPlan({ ...replacePlan, version: 1 }, "xai/grok-4.5"));
  assert.throws(() => validateNativeReplayPlan({ ...replacePlan, model: "openai/gpt-5.6" }, "xai/grok-4.5"));
  assert.throws(() =>
    validateNativeReplayPlan({ version: 2, mode: "replace", model: "xai/grok-4.5", compactedWindow: [] }, "xai/grok-4.5"),
  );
});

test("xAI native replay keeps the opaque compaction item first", () => {
  const body = {
    model: "grok-4.5",
    input: [
      { role: "developer", content: "fresh prompt that xAI compaction already contains" },
      { role: "user", content: "placeholder" },
      { role: "developer", content: "trailing provider hint" },
    ],
  };
  const rewritten = applyNativeReplayPlan(
    body,
    {
      version: 2,
      mode: "replace",
      model: body.model,
      compactedWindow: [{ type: "compaction", encrypted_content: "opaque-xai" }],
      liveTail: [{ role: "user", content: "live tail" }],
    },
    "xai-compaction-head",
  );
  assert.deepEqual(rewritten.input, [
    { type: "compaction", encrypted_content: "opaque-xai" },
    { role: "user", content: "live tail" },
  ]);
});

test("compact protocol validates requests and captures safe request-template fields", () => {
  const payload = {
    modelId: "gpt-5.6-luna",
    request: {
      model: "gpt-5.6-luna",
      input: [],
      instructions: "compact",
      tools: [{ type: "function" }],
      stream: true,
    },
  };
  assert.equal(validateCompactPayload(payload), payload);
  assert.deepEqual(extractCompactRequestTemplate(payload.request), {
    tools: [{ type: "function" }],
  });
  assert.throws(() => validateCompactPayload({ ...payload, modelId: "gpt-5.6-sol" }));
});

test("compact protocol permits xAI-compatible requests without top-level instructions", () => {
  const payload = {
    modelId: "xai/grok-4.5",
    request: {
      model: "xai/grok-4.5",
      input: [{ role: "system", content: "preserved inside the compacted context" }],
    },
  };
  assert.equal(validateCompactPayload(payload), payload);
});

test("relay catalog uses collision-safe provider/model ids and per-model compaction capabilities", () => {
  const models = [
    {
      id: "gpt-5.6",
      name: "GPT-5.6",
      provider: "openai",
      api: "openai-responses",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 },
      contextWindow: 272000,
      maxTokens: 128000,
    },
    {
      id: "grok-4.5",
      name: "Grok 4.5",
      provider: "xai",
      api: "openai-responses",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null },
      input: ["text", "image"],
      cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 500000,
      maxTokens: 500000,
    },
    {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      provider: "openai-codex",
      api: "openai-codex-responses",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 372000,
      maxTokens: 128000,
    },
  ];
  const catalog = createRelayCatalog(models);

  assert.equal(createRelayModelId("xai", "grok-4.5"), "xai/grok-4.5");
  assert.deepEqual(parseRelayModelId("openrouter/anthropic/claude"), {
    provider: "openrouter",
    modelId: "anthropic/claude",
  });
  assert.equal(catalog.models[0].id, "openai-codex/gpt-5.6-sol");
  assert.deepEqual(catalog.models[1].nativeCompaction, {
    apiFamily: "openai-responses",
    replayPolicy: "canonical-window",
  });
  assert.deepEqual(catalog.models[2].nativeCompaction, {
    apiFamily: "openai-responses",
    replayPolicy: "xai-compaction-head",
  });
  assert.equal(validateRelayCatalog(catalog), catalog);
  assert.deepEqual(nativeCompactionSupport(models[2]), {
    apiFamily: "openai-codex-responses",
    replayPolicy: "codex-fresh-context",
  });
});

test("model runtime manager recreates its runtime when Pi auth files change", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-model-relay-runtime-"));
  const authPath = join(root, "auth.json");
  const modelsPath = join(root, "models.json");
  const modelsStorePath = join(root, "models-store.json");
  writeFileSync(authPath, "{}\n");
  let creations = 0;
  const manager = createRelayModelRuntimeManager({
    authPath,
    modelsPath,
    modelsStorePath,
    createRuntime: async () => ({ generation: ++creations }),
  });

  const first = await manager.getRuntime();
  const unchanged = await manager.getRuntime();
  writeFileSync(authPath, '{"xai":{"type":"oauth"}}\n');
  const reloaded = await manager.getRuntime();

  assert.equal(first, unchanged);
  assert.equal(first.generation, 1);
  assert.equal(reloaded.generation, 2);
});
