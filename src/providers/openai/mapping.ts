import type { Message, ContentPart, ToolDefinition, ToolCall } from "../../core/types.js";

/** OpenAI's chat message shape (the subset we actually send/receive). */
export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export type OpenAIContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * Converts our normalized Message[] into OpenAI's wire format.
 * `system` is prepended as its own message if provided, matching how
 * OpenAI expects system instructions.
 */
export function toOpenAIMessages(messages: Message[], system?: string): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const message of messages) {
    result.push(...toOpenAIMessage(message));
  }

  return result;
}

/**
 * A single Antra message can expand into multiple OpenAI messages —
 * e.g. an assistant message containing both text and tool_calls stays
 * one message, but tool_result parts must become separate `role: "tool"`
 * messages (OpenAI requires one message per tool result).
 */
function toOpenAIMessage(message: Message): OpenAIMessage[] {
  if (typeof message.content === "string") {
    return [{ role: message.role, content: message.content }];
  }

  const toolResults = message.content.filter(
    (p): p is Extract<ContentPart, { type: "tool_result" }> => p.type === "tool_result"
  );
  const toolCalls = message.content.filter(
    (p): p is Extract<ContentPart, { type: "tool_call" }> => p.type === "tool_call"
  );
  const rest = message.content.filter((p) => p.type !== "tool_result" && p.type !== "tool_call");

  const messages: OpenAIMessage[] = [];

  // Text/image content (and tool_calls, if this is an assistant message) stay as one message.
  if (rest.length > 0 || toolCalls.length > 0) {
    const content: OpenAIContentPart[] = rest.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "image") return { type: "image_url", image_url: { url: part.url } };
      throw new Error(
        `Unsupported content part type in OpenAI mapping: ${(part as { type: string }).type}`
      );
    });

    messages.push({
      role: message.role,
      content: content.length > 0 ? content : toolCalls.length > 0 ? null : "",
      ...(toolCalls.length > 0
        ? {
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            })),
          }
        : {}),
    });
  }

  // Each tool_result becomes its own `role: "tool"` message.
  for (const tr of toolResults) {
    messages.push({
      role: "tool",
      tool_call_id: tr.toolCallId,
      content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
    });
  }

  return messages;
}

/** Converts our ToolDefinition[] into OpenAI's function-tool wire format. */
export function toOpenAITools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** Parses OpenAI's tool_calls array (from a non-streaming response) into our ToolCall[]. */
export function fromOpenAIToolCalls(toolCalls: OpenAIToolCall[] | undefined): ToolCall[] {
  if (!toolCalls) return [];
  return toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    args: safeJsonParse(tc.function.arguments),
  }));
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Model produced malformed JSON args — hand back the raw string so the
    // caller (or ToolExecutionError downstream) can surface it rather than
    // us throwing deep inside response parsing.
    return text;
  }
}
