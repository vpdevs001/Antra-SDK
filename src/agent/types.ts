import type { GenerateResult, ToolCall } from "../core/types.js";
import type { GuardrailMode } from "../guardrails/types.js";
import type { Trace } from "./trace.js";

/**
 * Every event an Agent emits during a run. Formalizes the POC's single
 * `Interceptor(message)` callback into typed events per step, so
 * listeners can react to exactly what they care about instead of
 * parsing message content to figure out what happened.
 *
 * Every variant carries `runId` — the same id for every event of a
 * given `run()` call (and, across a handoff chain, the same id for
 * every agent's events too), so listeners on an Agent instance shared
 * across concurrent runs can tell events apart. This closes the gap
 * Chapter 10 deliberately left open.
 */
export type AgentEvent =
  | { type: "step_start"; runId: string; step: number }
  | { type: "text_delta"; runId: string; step: number; text: string }
  | {
      type: "model_response";
      runId: string;
      step: number;
      result: GenerateResult;
      durationMs: number;
      retries: number;
      streamed: boolean;
    }
  | { type: "tool_call_start"; runId: string; step: number; toolCall: ToolCall }
  | { type: "tool_call_end"; runId: string; step: number; toolCall: ToolCall; result: unknown }
  | { type: "tool_call_error"; runId: string; step: number; toolCall: ToolCall; error: unknown }
  | {
      type: "guardrail_triggered";
      runId: string;
      step: number;
      guardrailType: "input" | "output" | "tool";
      guardrailName: string | undefined;
      mode: GuardrailMode;
      reason: string;
    }
  | {
      type: "output_repair_attempted";
      runId: string;
      step: number;
      attempt: number;
      reason: string;
    }
  | {
      type: "retry_attempted";
      runId: string;
      step: number;
      attempt: number;
      delayMs: number;
      errorCode: string;
      errorMessage: string;
    }
  | {
      type: "handoff_started";
      runId: string;
      step: number;
      fromAgent: string;
      toAgent: string;
      reason: string;
      depth: number;
    }
  | { type: "handoff_completed"; runId: string; step: number; fromAgent: string; toAgent: string }
  | { type: "finish"; runId: string; step: number; result: AgentResult };

export type AgentListener = (event: AgentEvent) => void;

export type AgentFinishReason =
  | "stop" // model produced a final answer with no further tool calls
  | "max_steps" // hit maxSteps before the model stopped calling tools
  | "aborted" // cancelled via AbortSignal
  | "guardrail_blocked" // a soft-mode input or output guardrail ended the run early
  | "limit_exceeded"; // maxTokens or maxDurationMs was reached (Chapter 11)

export interface AgentResult {
  /** Unique per run() call — the same id shared across a handoff chain. Correlates with Trace.runId and every AgentEvent from this run. */
  runId: string;
  /** The final text answer from the model. */
  content: string;
  /** Full conversation transcript, including all tool calls/results. */
  messages: import("../core/types.js").Message[];
  finishReason: AgentFinishReason;
  /** Number of model round-trips actually taken (by whichever agent produced the final answer, after any handoffs). */
  steps: number;
  /**
   * Sequence of agent names this run passed through, in order, e.g.
   * `["router", "billing-specialist"]`. Only present when at least one
   * handoff occurred — absent on a normal single-agent run.
   */
  handoffChain?: string[];
  /** Structured execution record — model calls, tool calls, handoffs, retries, errors, timing, usage. Also queryable later via `agent.getTrace(runId)`. */
  trace: Trace;
}
