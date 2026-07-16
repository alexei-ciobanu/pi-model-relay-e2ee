const TEMPLATE_FIELDS = ["tools", "parallel_tool_calls", "reasoning", "service_tier", "prompt_cache_key", "text"];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPromptEnvelopeItem(item) {
  return isRecord(item) && (item.role === "developer" || item.role === "system");
}

function clone(value) {
  return structuredClone(value);
}

export function extractCompactRequestTemplate(body) {
  if (!isRecord(body)) return {};
  const fields = {};
  for (const field of TEMPLATE_FIELDS) {
    if (body[field] !== undefined) fields[field] = clone(body[field]);
  }
  return fields;
}

export function applyNativeReplayPlan(body, plan) {
  if (!isRecord(body) || !Array.isArray(body.input)) throw new Error("Codex request payload is not replay-compatible");
  if (!isRecord(plan) || plan.version !== 1 || plan.model !== body.model) {
    throw new Error("Native replay plan does not match the Codex request");
  }

  let leadingBoundary = 0;
  while (leadingBoundary < body.input.length && isPromptEnvelopeItem(body.input[leadingBoundary])) leadingBoundary++;
  let trailingBoundary = body.input.length;
  while (trailingBoundary > leadingBoundary && isPromptEnvelopeItem(body.input[trailingBoundary - 1]))
    trailingBoundary--;
  for (let index = leadingBoundary; index < trailingBoundary; index++) {
    if (isPromptEnvelopeItem(body.input[index]))
      throw new Error("Codex request has an unsupported mid-conversation prompt item");
  }

  const leading = body.input.slice(0, leadingBoundary).map(clone);
  const trailing = body.input.slice(trailingBoundary).map(clone);
  if (plan.mode === "replace" && Array.isArray(plan.input)) {
    return {
      ...body,
      input: [...leading, ...plan.input.map(clone), ...trailing],
    };
  }
  if (plan.mode === "inject" && Array.isArray(plan.compactedWindow)) {
    return {
      ...body,
      input: [...leading, ...plan.compactedWindow.map(clone), ...body.input.slice(leadingBoundary).map(clone)],
    };
  }
  throw new Error("Invalid native replay plan");
}

export function validateCompactPayload(payload) {
  if (!isRecord(payload) || typeof payload.modelId !== "string" || !payload.modelId) {
    throw new Error("Invalid encrypted compact request");
  }
  if (!isRecord(payload.request)) throw new Error("Invalid encrypted compact request");
  if (
    payload.request.model !== payload.modelId ||
    !Array.isArray(payload.request.input) ||
    typeof payload.request.instructions !== "string"
  ) {
    throw new Error("Invalid encrypted compact request");
  }
  return payload;
}
