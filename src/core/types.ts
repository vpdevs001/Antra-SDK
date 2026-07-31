/**
 * Core types shared across every provider.
 * This is the "wire format" that Antra SDK speaks internally.
 * Each provider translates to/from this shape.
 */

export type Role = "system" | "user" | "assistant" | "tool";

/** A single piece of message content. Messages are arrays of these so we can mix text, images, and tool calls/results. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string } // remote URL or data: URI
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; toolCallId: string; result: unknown; isError?: boolean };

export interface Message {
  role: Role;
  content: string | ContentPart[];
}

/** Normalized token usage, since every provider reports this differently. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Why generation stopped. Normalized across providers (OpenAI's "stop"/"tool_calls", Anthropic's "end_turn"/"tool_use", etc). */
export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error";

export interface GenerateResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
  /** Raw provider response, escape hatch for advanced users. */
  raw: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** A single chunk emitted while streaming. Consumers iterate these with `for await`. */
export type StreamChunk =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argsDelta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "finish"; finishReason: FinishReason; usage: Usage }
  | { type: "error"; error: unknown };

export interface GenerateOptions {
  model: string;
  messages: Message[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "required" | "none" | { toolName: string };
  signal?: AbortSignal;
}

/** Provider-agnostic tool definition. `parameters` is a JSON Schema object (typically produced from a zod schema — see tools/define-tool.ts). */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}
