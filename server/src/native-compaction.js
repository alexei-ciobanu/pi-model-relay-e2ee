const TEMPLATE_FIELDS = ["tools", "parallel_tool_calls", "reasoning", "service_tier", "prompt_cache_key", "text"];
const RETAINED_USER_MESSAGE_TOKEN_BUDGET = 64_000;
const APPROX_BYTES_PER_TOKEN = 4;
const CONTEXTUAL_USER_PREFIXES = [
  "# AGENTS.md instructions for ",
  "<user_instructions>",
  "<environment_context>",
  "<skill>",
  "<user_shell_command>",
  "<turn_aborted>",
  "<subagent_notification>",
  "<codex_internal_context",
  "<goal_context>",
];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPromptEnvelopeItem(item) {
  return isRecord(item) && (item.role === "developer" || item.role === "system");
}

function clone(value) {
  return structuredClone(value);
}

function isTextContentPart(value) {
  return (
    isRecord(value) && (value.type === "input_text" || value.type === "output_text") && typeof value.text === "string"
  );
}

function isImageContentPart(value) {
  return isRecord(value) && value.type === "input_image";
}

function approximateTextTokens(text) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / APPROX_BYTES_PER_TOKEN);
}

function isHookPromptText(text) {
  const trimmed = text.trim();
  return /^<hook_prompt\s+hook_run_id="[^"]+">/.test(trimmed) && trimmed.endsWith("</hook_prompt>");
}

function isContextualUserText(text) {
  const trimmed = text.trim();
  if (CONTEXTUAL_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true;
  const external = trimmed.match(/^<external_([^>]+)>/);
  if (external?.[1] && trimmed.endsWith(`</external_${external[1]}>`)) return true;
  if (
    trimmed.startsWith("Warning: apply_patch was requested via ") &&
    trimmed.endsWith("Use the apply_patch tool instead of exec_command.")
  )
    return true;
  return (
    trimmed.startsWith("Warning: Your account was flagged for potentially high-risk cyber activity") ||
    trimmed.startsWith("Warning: The maximum number of unified exec processes you can keep open is")
  );
}

function isRealUserMessage(item) {
  if (!isRecord(item) || item.role !== "user") return false;
  if (typeof item.content === "string") {
    return item.content.trim().length > 0 && !isContextualUserText(item.content);
  }
  if (!Array.isArray(item.content)) return false;
  const textParts = item.content.filter(isTextContentPart);
  const hasHookPrompt = textParts.some((part) => isHookPromptText(part.text));
  if (hasHookPrompt) {
    return (
      item.content.every(isTextContentPart) &&
      textParts.every((part) => isHookPromptText(part.text) || isContextualUserText(part.text))
    );
  }
  if (textParts.some((part) => isContextualUserText(part.text))) return false;
  return item.content.some(
    (part) => (isTextContentPart(part) && part.text.trim().length > 0) || isImageContentPart(part),
  );
}

function approximateMessageTokens(item) {
  if (typeof item.content === "string") return Math.max(1, approximateTextTokens(item.content));
  if (!Array.isArray(item.content)) return 1;
  const tokens = item.content.reduce(
    (sum, part) => sum + (isTextContentPart(part) ? approximateTextTokens(part.text) : 0),
    0,
  );
  return Math.max(1, tokens);
}

function truncateTextToTokenBudget(text, maxTokens) {
  const maxBytes = Math.max(0, maxTokens * APPROX_BYTES_PER_TOKEN);
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) return text;

  const leftBudget = Math.floor(maxBytes / 2);
  const rightBudget = maxBytes - leftBudget;
  let prefix = "";
  let prefixBytes = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (prefixBytes + bytes > leftBudget) break;
    prefix += character;
    prefixBytes += bytes;
  }

  let suffix = "";
  let suffixBytes = 0;
  for (const character of Array.from(text).reverse()) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (suffixBytes + bytes > rightBudget) break;
    suffix = `${character}${suffix}`;
    suffixBytes += bytes;
  }
  const removedTokens = Math.ceil(Math.max(0, totalBytes - maxBytes) / APPROX_BYTES_PER_TOKEN);
  return `${prefix}…${removedTokens} tokens truncated…${suffix}`;
}

function truncateUserMessage(item, maxTokens) {
  if (maxTokens <= 0) return undefined;
  if (typeof item.content === "string") {
    const content = truncateTextToTokenBudget(item.content, maxTokens);
    return content ? { ...clone(item), content } : undefined;
  }
  if (!Array.isArray(item.content)) return clone(item);

  let remainingTokens = maxTokens;
  const content = [];
  for (const part of item.content) {
    if (!isTextContentPart(part)) {
      content.push(clone(part));
      continue;
    }
    if (remainingTokens === 0) continue;
    const tokenCount = approximateTextTokens(part.text);
    const text = tokenCount <= remainingTokens ? part.text : truncateTextToTokenBudget(part.text, remainingTokens);
    remainingTokens = Math.max(0, remainingTokens - tokenCount);
    if (text) content.push({ ...clone(part), text });
  }
  return content.length > 0 ? { ...clone(item), content } : undefined;
}

function truncateRetainedUserMessages(items, maxTokens) {
  let remainingTokens = maxTokens;
  const retainedReversed = [];
  for (const item of [...items].reverse()) {
    if (remainingTokens === 0) break;
    const tokenCount = approximateMessageTokens(item);
    if (tokenCount <= remainingTokens) {
      retainedReversed.push(clone(item));
      remainingTokens -= tokenCount;
      continue;
    }
    const truncated = truncateUserMessage(item, remainingTokens);
    if (truncated) retainedReversed.push(truncated);
    remainingTokens = 0;
  }
  return retainedReversed.reverse();
}

function eventErrorMessage(event, fallback) {
  if (typeof event.message === "string" && event.message.trim()) return event.message;
  if (isRecord(event.error) && typeof event.error.message === "string" && event.error.message.trim()) {
    return event.error.message;
  }
  return fallback;
}

export function buildCodexRemoteCompactionRequest(request, modelId, sessionId) {
  if (!isRecord(request) || !Array.isArray(request.input)) {
    throw new Error("Invalid Codex remote compaction request");
  }
  const include = Array.isArray(request.include) ? request.include.filter((value) => typeof value === "string") : [];
  if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
  return {
    ...clone(request),
    model: modelId,
    input: [...request.input.map(clone), { type: "compaction_trigger" }],
    stream: true,
    store: false,
    include,
    ...(request.tool_choice === undefined ? { tool_choice: "auto" } : {}),
    ...(request.prompt_cache_key === undefined && sessionId ? { prompt_cache_key: sessionId } : {}),
  };
}

export function buildCompactUrl(baseUrl, apiFamily) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (apiFamily === "openai-codex-responses") {
    if (normalized.endsWith("/codex/responses")) return normalized;
    if (normalized.endsWith("/codex")) return `${normalized}/responses`;
    return `${normalized}/codex/responses`;
  }
  return normalized.endsWith("/responses") ? `${normalized}/compact` : `${normalized}/responses/compact`;
}

export function applyCodexRemoteCompactionHeaders(headers, options) {
  const features = (headers.get("x-codex-beta-features") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!features.includes("remote_compaction_v2")) features.push("remote_compaction_v2");
  headers.set("x-codex-beta-features", features.join(","));
  headers.set("x-codex-installation-id", options.installationId);
  headers.set("accept", "text/event-stream");
  if (options.sessionId) {
    headers.set("session_id", options.sessionId);
    headers.set("x-codex-window-id", `${options.sessionId}:0`);
  }
}

export function buildCodexRemoteCompactionHistory(input, compactionItem) {
  if (
    !isRecord(compactionItem) ||
    compactionItem.type !== "compaction" ||
    typeof compactionItem.encrypted_content !== "string" ||
    compactionItem.encrypted_content.length === 0
  ) {
    throw new Error("Codex remote compaction v2 did not return a compaction item");
  }
  const retainedUsers = input.filter(isRealUserMessage);
  return [
    ...truncateRetainedUserMessages(retainedUsers, RETAINED_USER_MESSAGE_TOKEN_BUDGET).map((item) =>
      item.type === "message" ? item : { type: "message", ...item },
    ),
    clone(compactionItem),
  ];
}

export function parseCodexRemoteCompactionSse(text) {
  if (typeof text !== "string") throw new Error("Invalid Codex remote compaction v2 stream");
  const blocks = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n\n+/);
  const events = [];
  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      throw new Error("Codex remote compaction v2 returned malformed SSE data");
    }
  }

  let completedResponse;
  const compactionItems = [];
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === "error") {
      throw new Error(`Codex remote compaction v2 failed: ${eventErrorMessage(event, "Unknown Responses API error")}`);
    }
    if (event.type === "response.failed") {
      const response = isRecord(event.response) ? event.response : {};
      throw new Error(`Codex remote compaction v2 failed: ${eventErrorMessage(response, "Response failed")}`);
    }
    if (event.type === "response.output_item.done" && isRecord(event.item) && event.item.type === "compaction") {
      compactionItems.push(event.item);
    }
    if (event.type === "response.completed" && isRecord(event.response)) completedResponse = event.response;
  }

  if (!completedResponse) throw new Error("Codex remote compaction v2 stream ended before response.completed");
  if (compactionItems.length !== 1) {
    throw new Error(`Codex remote compaction v2 expected exactly one compaction item, got ${compactionItems.length}`);
  }
  return { compactionItem: clone(compactionItems[0]), response: clone(completedResponse) };
}

export function normalizeCodexRemoteCompactionResponse(request, parsed) {
  return {
    ...(typeof parsed.response.id === "string" ? { id: parsed.response.id } : {}),
    object: "response.compaction",
    ...(parsed.response.created_at !== undefined ? { created_at: parsed.response.created_at } : {}),
    output: buildCodexRemoteCompactionHistory(request.input, parsed.compactionItem),
    ...(parsed.response.usage !== undefined ? { usage: parsed.response.usage } : {}),
  };
}

export async function executeCodexRemoteCompactionRequest(options) {
  const request = buildCodexRemoteCompactionRequest(options.request, options.modelId, options.sessionId);
  const upstream = await options.fetchImpl(options.url, {
    method: "POST",
    headers: options.headers,
    body: JSON.stringify(request),
    signal: options.signal,
  });
  const responseHeaders = Object.fromEntries(upstream.headers.entries());
  const upstreamBodyText = await upstream.text();
  if (!upstream.ok) {
    return { status: upstream.status, headers: responseHeaders, bodyText: upstreamBodyText };
  }
  const parsed = parseCodexRemoteCompactionSse(upstreamBodyText);
  return {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8" },
    bodyText: JSON.stringify(normalizeCodexRemoteCompactionResponse(options.request, parsed)),
  };
}

export function extractCompactRequestTemplate(body) {
  if (!isRecord(body)) return {};
  const fields = {};
  for (const field of TEMPLATE_FIELDS) {
    if (body[field] !== undefined) fields[field] = clone(body[field]);
  }
  return fields;
}

export function applyNativeReplayPlan(body, plan, replayPolicy = "canonical-window") {
  if (!isRecord(body) || !Array.isArray(body.input)) {
    throw new Error("Responses request payload is not replay-compatible");
  }
  if (!isRecord(plan) || plan.version !== 2 || plan.model !== body.model) {
    throw new Error("Native replay plan does not match the Responses request");
  }

  let leadingBoundary = 0;
  while (leadingBoundary < body.input.length && isPromptEnvelopeItem(body.input[leadingBoundary])) leadingBoundary++;
  let trailingBoundary = body.input.length;
  while (trailingBoundary > leadingBoundary && isPromptEnvelopeItem(body.input[trailingBoundary - 1]))
    trailingBoundary--;
  for (let index = leadingBoundary; index < trailingBoundary; index++) {
    if (isPromptEnvelopeItem(body.input[index]))
      throw new Error("Responses request has an unsupported mid-conversation prompt item");
  }

  const leading = body.input.slice(0, leadingBoundary).map(clone);
  const trailing = body.input.slice(trailingBoundary).map(clone);
  if (plan.mode === "replace" && Array.isArray(plan.compactedWindow) && Array.isArray(plan.liveTail)) {
    const compactedWindow = plan.compactedWindow.map(clone);
    const liveTail = plan.liveTail.map(clone);
    if (replayPolicy === "codex-fresh-context") {
      return {
        ...body,
        input: [...compactedWindow, ...leading, ...liveTail, ...trailing],
      };
    }
    const { instructions: _instructions, ...bodyWithoutInstructions } = body;
    return {
      ...bodyWithoutInstructions,
      input: [...compactedWindow, ...liveTail],
    };
  }
  if (plan.mode === "inject" && Array.isArray(plan.compactedWindow)) {
    return {
      ...body,
      input:
        replayPolicy === "xai-compaction-head" || replayPolicy === "canonical-window"
          ? [...plan.compactedWindow.map(clone), ...body.input.map(clone)]
          : [...leading, ...plan.compactedWindow.map(clone), ...body.input.slice(leadingBoundary).map(clone)],
    };
  }
  throw new Error("Invalid native replay plan");
}

export function validateNativeReplayPlan(plan, modelId) {
  if (!isRecord(plan) || plan.version !== 2 || plan.model !== modelId) {
    throw new Error("Invalid encrypted native replay plan");
  }
  if (plan.mode === "replace") {
    if (!Array.isArray(plan.compactedWindow) || !Array.isArray(plan.liveTail)) {
      throw new Error("Invalid encrypted native replay plan");
    }
    return plan;
  }
  if (plan.mode === "inject") {
    if (!Array.isArray(plan.compactedWindow)) {
      throw new Error("Invalid encrypted native replay plan");
    }
    return plan;
  }
  throw new Error("Invalid encrypted native replay plan");
}

export function validateCompactPayload(payload) {
  if (!isRecord(payload) || typeof payload.modelId !== "string" || !payload.modelId) {
    throw new Error("Invalid encrypted compact request");
  }
  if (!isRecord(payload.request)) throw new Error("Invalid encrypted compact request");
  if (
    payload.request.model !== payload.modelId ||
    !Array.isArray(payload.request.input) ||
    (payload.request.instructions !== undefined && typeof payload.request.instructions !== "string")
  ) {
    throw new Error("Invalid encrypted compact request");
  }
  return payload;
}
