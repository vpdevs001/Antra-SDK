import type { Usage, FinishReason } from "../core/types.js";
import type { AgentFinishReason } from "./types.js";

export interface TraceModelCall {
  step: number;
  agentName: string;
  model: string;
  startedAt: number;
  durationMs: number;
  usage: Usage;
  finishReason: FinishReason;
  streamed: boolean;
  /** Retry attempts consumed before this call succeeded (0 if it succeeded on the first try). */
  retries: number;
}

export interface TraceToolCall {
  step: number;
  toolName: string;
  durationMs: number;
  isError: boolean;
}

export interface TraceHandoff {
  step: number;
  fromAgent: string;
  toAgent: string;
  reason: string;
  depth: number;
}

export interface TraceRetry {
  step: number;
  agentName: string;
  attempt: number;
  delayMs: number;
  errorCode: string;
  errorMessage: string;
}

export interface TraceError {
  step: number;
  code: string;
  message: string;
}

/**
 * The structured execution record for a run. Shared and mutable across
 * a handoff chain — when agent A hands off to agent B, both keep
 * writing into the SAME Trace object (threaded through internally),
 * so one Trace captures the full cross-agent picture rather than
 * fragmenting into one trace per agent per hop.
 */
export interface Trace {
  runId: string;
  /** Every agent involved, in order (more than one only if a handoff occurred). */
  agentNames: string[];
  startedAt: number;
  /** Set once the run finishes; undefined while still in progress. */
  durationMs: number | undefined;
  modelCalls: TraceModelCall[];
  toolCalls: TraceToolCall[];
  handoffs: TraceHandoff[];
  retries: TraceRetry[];
  errors: TraceError[];
  totalUsage: Usage;
  finalOutput: string | undefined;
  finishReason: AgentFinishReason | undefined;
}

export function createTrace(runId: string, agentName: string): Trace {
  return {
    runId,
    agentNames: [agentName],
    startedAt: Date.now(),
    durationMs: undefined,
    modelCalls: [],
    toolCalls: [],
    handoffs: [],
    retries: [],
    errors: [],
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finalOutput: undefined,
    finishReason: undefined,
  };
}

export function addUsage(trace: Trace, usage: Usage): void {
  trace.totalUsage = {
    inputTokens: trace.totalUsage.inputTokens + usage.inputTokens,
    outputTokens: trace.totalUsage.outputTokens + usage.outputTokens,
    totalTokens: trace.totalUsage.totalTokens + usage.totalTokens,
  };
}

export function finalizeTrace(
  trace: Trace,
  finalOutput: string,
  finishReason: AgentFinishReason
): void {
  trace.durationMs = Date.now() - trace.startedAt;
  trace.finalOutput = finalOutput;
  trace.finishReason = finishReason;
}
