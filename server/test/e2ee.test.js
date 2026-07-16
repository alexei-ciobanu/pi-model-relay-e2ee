import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  deriveKey,
  E2EE_VERSION,
  openJson,
  requestAad,
  responseAad,
  sealJson,
  validateRequestEnvelope,
} from "../../shared/e2ee.js";
import {
  applyNativeReplayPlan,
  extractCompactRequestTemplate,
  validateCompactPayload,
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
  assert.throws(() => validateRequestEnvelope({ ...valid, v: 2 }, now));
  assert.throws(() => validateRequestEnvelope({ ...valid, timestamp: now - 120_000 }, now));
});

test("native replay replaces Pi's summary window while preserving provider prompt items", () => {
  const body = {
    model: "gpt-5.6-luna",
    input: [
      { role: "developer", content: "leading" },
      { role: "user", content: "placeholder" },
      { role: "developer", content: "trailing" },
    ],
  };
  const rewritten = applyNativeReplayPlan(body, {
    version: 1,
    mode: "replace",
    model: body.model,
    input: [
      { type: "compaction", encrypted_content: "opaque" },
      { role: "user", content: "live tail" },
    ],
  });
  assert.deepEqual(rewritten.input, [
    body.input[0],
    { type: "compaction", encrypted_content: "opaque" },
    { role: "user", content: "live tail" },
    body.input[2],
  ]);
});

test("native replay injects an older opaque window into Pi fallback compaction", () => {
  const body = {
    model: "gpt-5.6-luna",
    input: [{ role: "user", content: "summarize this" }],
  };
  const rewritten = applyNativeReplayPlan(body, {
    version: 1,
    mode: "inject",
    model: body.model,
    compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }],
  });
  assert.deepEqual(rewritten.input, [{ type: "compaction", encrypted_content: "opaque" }, body.input[0]]);
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
