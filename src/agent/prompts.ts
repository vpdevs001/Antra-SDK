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
