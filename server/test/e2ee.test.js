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
  applyCodexRemoteCompactionHeaders,
  applyNativeReplayPlan,
  buildCodexRemoteCompactionHistory,
  buildCodexRemoteCompactionRequest,
  buildCompactUrl,
  executeCodexRemoteCompactionRequest,
  extractCompactRequestTemplate,
  normalizeCodexRemoteCompactionResponse,
  parseCodexRemoteCompactionSse,
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
    validateNativeReplayPlan(
      { version: 2, mode: "replace", model: "xai/grok-4.5", compactedWindow: [] },
      "xai/grok-4.5",
    ),
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

test("Codex remote compaction v2 appends a trigger and forces the streaming contract", () => {
  const request = {
    model: "openai-codex/gpt-5.6-sol",
    input: [{ role: "user", content: "remember synthetic-alpha" }],
    instructions: "synthetic instructions",
    tools: [{ type: "function", name: "lookup" }],
    include: ["other.include"],
  };
  const body = buildCodexRemoteCompactionRequest(request, "gpt-5.6-sol", "session-123");

  assert.equal(body.model, "gpt-5.6-sol");
  assert.deepEqual(body.input, [...request.input, { type: "compaction_trigger" }]);
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.prompt_cache_key, "session-123");
  assert.deepEqual(body.include, ["other.include", "reasoning.encrypted_content"]);
  assert.deepEqual(request.input, [{ role: "user", content: "remember synthetic-alpha" }]);

  assert.equal(
    buildCompactUrl("https://chatgpt.com/backend-api", "openai-codex-responses"),
    "https://chatgpt.com/backend-api/codex/responses",
  );
  assert.equal(
    buildCompactUrl("https://api.openai.com/v1", "openai-responses"),
    "https://api.openai.com/v1/responses/compact",
  );
  const headers = new Headers({ "x-codex-beta-features": "existing_feature" });
  applyCodexRemoteCompactionHeaders(headers, {
    installationId: "11111111-1111-4111-8111-111111111111",
    sessionId: "session-123",
  });
  assert.equal(headers.get("accept"), "text/event-stream");
  assert.equal(headers.get("x-codex-beta-features"), "existing_feature,remote_compaction_v2");
  assert.equal(headers.get("x-codex-window-id"), "session-123:0");
});

test("Codex remote compaction v2 parses CRLF SSE and builds replay history", () => {
  const compactionItem = { type: "compaction", encrypted_content: "opaque-synthetic" };
  const parsed = parseCodexRemoteCompactionSse(
    [
      `event: response.output_item.done\r\ndata: ${JSON.stringify({ type: "response.output_item.done", item: compactionItem })}`,
      `event: response.completed\r\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_synthetic", created_at: 123, usage: { input_tokens: 10 } },
      })}`,
      "data: [DONE]",
      "",
    ].join("\r\n\r\n"),
  );

  assert.deepEqual(parsed.compactionItem, compactionItem);
  assert.equal(parsed.response.id, "resp_synthetic");
  const request = {
    input: [
      { role: "developer", content: "do not retain" },
      { role: "user", content: "retain synthetic-alpha" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "retain synthetic-beta" }] },
    ],
  };
  const expectedOutput = [
    { type: "message", role: "user", content: "retain synthetic-alpha" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "retain synthetic-beta" }] },
    compactionItem,
  ];
  assert.deepEqual(buildCodexRemoteCompactionHistory(request.input, parsed.compactionItem), expectedOutput);
  assert.deepEqual(normalizeCodexRemoteCompactionResponse(request, parsed), {
    id: "resp_synthetic",
    object: "response.compaction",
    created_at: 123,
    output: expectedOutput,
    usage: { input_tokens: 10 },
  });
});

test("Codex remote compaction v2 executes the upstream streaming contract and normalizes it for encryption", async () => {
  let captured;
  const request = {
    model: "openai-codex/gpt-5.6-sol",
    instructions: "synthetic instructions",
    input: [{ role: "user", content: "remember synthetic-gamma" }],
  };
  const result = await executeCodexRemoteCompactionRequest({
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(
        [
          `data: ${JSON.stringify({
            type: "response.output_item.done",
            item: { type: "compaction", encrypted_content: "opaque-gamma" },
          })}`,
          `data: ${JSON.stringify({
            type: "response.completed",
            response: { id: "resp_gamma", usage: { input_tokens: 12 } },
          })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
    url: "https://chatgpt.com/backend-api/codex/responses",
    headers: new Headers({ accept: "text/event-stream" }),
    request,
    modelId: "gpt-5.6-sol",
    sessionId: "session-gamma",
    signal: new AbortController().signal,
  });

  assert.equal(captured.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(captured.init.method, "POST");
  const upstreamBody = JSON.parse(captured.init.body);
  assert.equal(upstreamBody.model, "gpt-5.6-sol");
  assert.deepEqual(upstreamBody.input.at(-1), { type: "compaction_trigger" });
  assert.equal(upstreamBody.prompt_cache_key, "session-gamma");
  assert.equal(result.status, 200);
  assert.deepEqual(result.headers, { "content-type": "application/json; charset=utf-8" });
  assert.deepEqual(JSON.parse(result.bodyText), {
    id: "resp_gamma",
    object: "response.compaction",
    output: [
      { type: "message", role: "user", content: "remember synthetic-gamma" },
      { type: "compaction", encrypted_content: "opaque-gamma" },
    ],
    usage: { input_tokens: 12 },
  });
});

test("Codex remote compaction v2 mirrors the 64k UTF-8 retention budget and preserves image-only users", () => {
  const oversizedUnicodeText = `START-${"🙂".repeat(70_000)}-END`;
  const imageOnlyUser = {
    role: "user",
    content: [{ type: "input_image", image_url: "data:image/png;base64,c3ludGhldGlj" }],
  };
  const compactionItem = { type: "compaction", encrypted_content: "opaque-synthetic" };
  const history = buildCodexRemoteCompactionHistory(
    [{ role: "user", content: [{ type: "input_text", text: oversizedUnicodeText }] }, imageOnlyUser],
    compactionItem,
  );

  assert.equal(history.length, 3);
  const retainedText = history[0].content[0].text;
  assert.match(retainedText, /^START-/);
  assert.match(retainedText, /-END$/);
  assert.match(retainedText, /tokens truncated/);
  assert.deepEqual(history[1], { type: "message", ...imageOnlyUser });
  assert.deepEqual(history[2], compactionItem);
});

test("Codex remote compaction v2 drops contextual users before budgeting while retaining hook prompts", () => {
  const hookPrompt = '<hook_prompt hook_run_id="hook-1">Review this.</hook_prompt>';
  const history = buildCodexRemoteCompactionHistory(
    [
      { role: "user", content: "retain the real oldest request" },
      { role: "user", content: `<environment_context>${"x".repeat(300_000)}</environment_context>` },
      { role: "user", content: "# AGENTS.md instructions for /tmp\n\n<INSTRUCTIONS>stale</INSTRUCTIONS>" },
      { role: "user", content: "<user_shell_command>stale shell context</user_shell_command>" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "real text mixed with context" },
          { type: "input_text", text: "<turn_aborted>stale</turn_aborted>" },
        ],
      },
      { role: "user", content: [{ type: "input_text", text: hookPrompt }] },
    ],
    { type: "compaction", encrypted_content: "opaque-context-filter" },
  );

  assert.deepEqual(history, [
    { type: "message", role: "user", content: "retain the real oldest request" },
    { type: "message", role: "user", content: [{ type: "input_text", text: hookPrompt }] },
    { type: "compaction", encrypted_content: "opaque-context-filter" },
  ]);
});

test("Codex remote compaction v2 rejects compaction items without opaque content", () => {
  assert.throws(
    () => buildCodexRemoteCompactionHistory([], { type: "compaction" }),
    /did not return a compaction item/,
  );
  assert.throws(
    () => buildCodexRemoteCompactionHistory([], { type: "compaction", encrypted_content: "" }),
    /did not return a compaction item/,
  );
});

test("Codex remote compaction v2 rejects failed, incomplete, and ambiguous streams", () => {
  assert.throws(
    () =>
      parseCodexRemoteCompactionSse(
        'data: {"type":"response.failed","response":{"error":{"message":"bad request"}}}\n\n',
      ),
    /bad request/,
  );
  assert.throws(
    () => parseCodexRemoteCompactionSse('data: {"type":"response.output_item.done","item":{"type":"compaction"}}\n\n'),
    /before response.completed/,
  );
  assert.throws(
    () => parseCodexRemoteCompactionSse('data: {"type":"response.completed","response":{}}\n\n'),
    /exactly one compaction item, got 0/,
  );
  assert.throws(() => parseCodexRemoteCompactionSse("data: {not-json}\n\n"), /malformed SSE data/);
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
