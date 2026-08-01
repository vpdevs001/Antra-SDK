import type { ToolCall } from "../core/types.js";

/**
 * How a triggered guardrail behaves. This is deliberately not defaulted
 * anywhere in the SDK — the person registering a guardrail must say
 * explicitly whether a violation should hard-fail the run or let the
 * agent react and continue. Silently picking one would be exactly the
 * kind of surprising behavior Chapter 0 rules out.
 *
 * - "strict": a failed guardrail throws a GuardrailError, rejecting the
 *   `run()` call outright.
 * - "soft": a failed guardrail does NOT throw. The agent reacts
 *   programmatically instead — input/output guardrails end the run
 *   early with finishReason "guardrail_blocked"; tool guardrails block
 *   just that tool call and feed the reason back to the model as a
 *   tool_result, letting the model try something else.
 */
export type GuardrailMode = "strict" | "soft";

export interface GuardrailResult {
  passed: boolean;
  /** Human-readable reason, required when passed is false — this is what gets surfaced to the model/caller/trace. */
  reason?: string;
  /**
   * Optional replacement value when the guardrail wants to modify rather
   * than just reject — e.g. an output guardrail redacting PII from an
   * otherwise-passing response. Ignored when passed is false.
   */
  modifiedValue?: string;
}

export type InputGuardrail = (input: string) => GuardrailResult | Promise<GuardrailResult>;
export type OutputGuardrail = (output: string) => GuardrailResult | Promise<GuardrailResult>;
/** Runs before a requested tool call executes. Allow/reject only for now — approval-flow (pause and wait for a human) is a later addition. */
export type ToolGuardrail = (toolCall: ToolCall) => GuardrailResult | Promise<GuardrailResult>;

export interface GuardrailRegistration<TFn> {
  fn: TFn;
  mode: GuardrailMode;
  /** Optional name for tracing/logs — falls back to "unnamed" in events if omitted. */
  name?: string;
}
