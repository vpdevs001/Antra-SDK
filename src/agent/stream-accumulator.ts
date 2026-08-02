import type { GenerateResult, StreamChunk, ToolCall, FinishReason, Usage } from "../core/types.js";

/**
 * Consumes a raw `StreamChunk` stream (Chapter 2's provider-agnostic
 * streaming format) and reconstructs the same `GenerateResult` shape
 * `client.generate()` would have returned — so the rest of the agent
 * loop (tool execution, output guardrails, session persistence) doesn't
 * need to know or care whether a given turn was streamed or buffered.
 *
 * `onTextDelta` is called synchronously as each text chunk arrives —
 * this is the hook `Agent.run()` uses to emit real `text_delta` events
 * live, rather than only after the full response is in.
 */
export async function accumulateStream(
  stream: AsyncGenerator<StreamChunk, void, unknown>,
  onTextDelta: (text: string) => void
): Promise<GenerateResult> {
  let content = "";
  const toolCallState = new Map<string, { name: string; argsJson: string }>();
  const toolCallOrder: string[] = [];
  let finishReason: FinishReason = "stop";
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "text_delta":
        content += chunk.text;
        onTextDelta(chunk.text);
        break;
      case "tool_call_start":
        toolCallState.set(chunk.id, { name: chunk.name, argsJson: "" });
        toolCallOrder.push(chunk.id);
        break;
      case "tool_call_delta": {
        const state = toolCallState.get(chunk.id);
        if (state) state.argsJson += chunk.argsDelta;
        break;
      }
      case "tool_call_end":
        break; // argument JSON is parsed after the loop, once fully accumulated
      case "finish":
        finishReason = chunk.finishReason;
        usage = chunk.usage;
        break;
      case "error":
        throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error));
      default:
        break;
    }
  }

  const toolCalls: ToolCall[] = toolCallOrder.map((id) => {
    const state = toolCallState.get(id);
    return { id, name: state?.name ?? "", args: safeJsonParse(state?.argsJson ?? "") };
  });

  return { content, toolCalls, finishReason, usage, raw: undefined };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Same handling as the OpenAI/Anthropic providers use for malformed
    // tool-call JSON — hand back the raw string rather than throwing
    // deep inside stream accumulation.
    return text;
  }
}
