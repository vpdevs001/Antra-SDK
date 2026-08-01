import type {
  Message,
  ContentPart,
  ToolDefinition,
  ToolCall,
  FinishReason,
} from "../../core/types.js";

/** Anthropic's message shape — unlike OpenAI, `system` is a top-level field, never a message. */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/**
 * Converts our normalized Message[] into Anthropic's message array.
 * `system` is NOT included here — Anthropic takes it as a separate
 * top-level request field, so the provider sends it independently.
 *
 * Unlike OpenAI, tool results belong to a `user`-role message in
 * Anthropic's model, not a distinct "tool" role — we map our internal
 * `role: "tool"` messages onto that here.
 */
export function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") continue; // handled separately via the `system` request field
    result.push(toAnthropicMessage(message));
  }

  return result;
}

function toAnthropicMessage(message: Message): AnthropicMessage {
  const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";

  if (typeof message.content === "string") {
    return { role, content: [{ type: "text", text: message.content }] };
  }

  const blocks: AnthropicContentBlock[] = message.content.map((part) => toAnthropicBlock(part));
  return { role, content: blocks };
}

function toAnthropicBlock(part: ContentPart): AnthropicContentBlock {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return { type: "image", source: { type: "url", url: part.url } };
    case "tool_call":
      // Anthropic takes tool arguments as a real object (`input`), not a
      // stringified JSON blob — unlike OpenAI's `function.arguments: string`.
      return { type: "tool_use", id: part.id, name: part.name, input: part.args };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content: typeof part.result === "string" ? part.result : JSON.stringify(part.result),
        ...(part.isError ? { is_error: true } : {}),
      };
    default:
      throw new Error(
        `Unsupported content part type in Anthropic mapping: ${(part as { type: string }).type}`
      );
  }
}

/** Converts our ToolDefinition[] into Anthropic's tool wire format (`input_schema`, not `parameters`). */
export function toAnthropicTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

/** Parses Anthropic's response `content` blocks into plain text + our ToolCall[]. */
export function fromAnthropicContent(blocks: AnthropicContentBlock[]): {
  text: string;
  toolCalls: ToolCall[];
} {
  let text = "";
  const toolCalls: ToolCall[] = [];

  for (const block of blocks) {
    if (block.type === "text") text += block.text;
    if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, args: block.input });
    }
  }

  return { text, toolCalls };
}

export function mapAnthropicFinishReason(stopReason: string | null): FinishReason {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}
