/**
 * A light chain-of-thought nudge appended to every agent's system prompt.
 *
 * Deliberately NOT a JSON step-machine the model must follow exactly
 * (that was the POC's approach, and it's fragile — one malformed JSON
 * response and the whole loop throws). Tool execution rides entirely on
 * the provider's native tool-calling API (see Chapter 2), which already
 * gives us structured, guaranteed-valid tool call data. This prompt only
 * shapes the model's own reasoning text — it has no bearing on control
 * flow, so there's nothing here that can break the agent loop.
 */
export const COT_REASONING_NUDGE = `
Before answering or calling a tool, briefly reason step by step about
what the user is asking and what needs to happen next. Break multi-part
problems into smaller steps and work through them in order. Keep this
reasoning concise — a few sentences, not an essay — then act on it by
either calling the appropriate tool or giving your final answer.
`.trim();

/** Combines the user's own instructions with the CoT nudge and tool descriptions. */
export function buildSystemPrompt(instructions: string, useCotNudge: boolean): string {
  return useCotNudge ? `${instructions}\n\n${COT_REASONING_NUDGE}` : instructions;
}

/**
 * Appended to the system prompt for a single `run()` call when
 * `outputSchema` is passed. Unlike the CoT nudge, this DOES shape
 * control flow indirectly — the response text gets JSON.parse'd and
 * schema-validated afterwards — but the parsing/validation itself is
 * done with `JSON.parse` + zod, not by trusting the model to follow a
 * hand-rolled step protocol (the POC's original mistake).
 */
export function buildOutputInstructions(jsonSchema: Record<string, unknown>): string {
  return [
    "You must respond with ONLY valid JSON matching this schema — no extra commentary, no markdown code fences, no leading/trailing text:",
    JSON.stringify(jsonSchema, null, 2),
  ].join("\n\n");
}

/** Builds the follow-up message sent back to the model after its output failed schema validation, asking it to correct course. */
export function buildRepairMessage(reason: string): string {
  return [
    "Your previous response did not match the required output format.",
    reason,
    "Respond again with ONLY valid JSON matching the schema — no extra commentary, no markdown code fences.",
  ].join("\n\n");
}
