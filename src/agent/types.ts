import type { GenerateResult, ToolCall } from "../core/types.js";

/**
 * Every event an Agent emits during a run. Formalizes the POC's single
 * `Interceptor(message)` callback into typed events per step, so
 * listeners can react to exactly what they care about instead of
 * parsing message content to figure out what happened.
 */
export type AgentEvent =
  | { type: "step_start"; step: number }
  | { type: "model_response"; step: number; result: GenerateResult }
  | { type: "tool_call_start"; step: number; toolCall: ToolCall }
  | { type: "tool_call_end"; step: number; toolCall: ToolCall; result: unknown }
  | { type: "tool_call_error"; step: number; toolCall: ToolCall; error: unknown }
  | { type: "finish"; step: number; result: AgentResult };

export type AgentListener = (event: AgentEvent) => void;

export type AgentFinishReason =
  | "stop" // model produced a final answer with no further tool calls
  | "max_steps" // hit maxSteps before the model stopped calling tools
  | "aborted"; // cancelled via AbortSignal

export interface AgentResult {
  /** The final text answer from the model. */
  content: string;
  /** Full conversation transcript, including all tool calls/results. */
  messages: import("../core/types.js").Message[];
  finishReason: AgentFinishReason;
  /** Number of model round-trips actually taken. */
  steps: number;
}
