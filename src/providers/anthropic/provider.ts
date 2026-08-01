import type { Provider, ProviderCapabilities } from "../../core/provider.js";
import type {
  GenerateOptions,
  GenerateResult,
  StreamChunk,
  FinishReason,
  Usage,
} from "../../core/types.js";
import {
  toAnthropicMessages,
  toAnthropicTools,
  fromAnthropicContent,
  mapAnthropicFinishReason,
  type AnthropicContentBlock,
} from "./mapping.js";
import { mapAnthropicError } from "./errors.js";
import { parseSSE } from "../../streaming/sse.js";
import { TimeoutError, CancelledError, ProviderError } from "../../errors/index.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
/** Anthropic requires `max_tokens` on every request — no default on their side, so we supply one. */
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicProviderConfig {
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
}

// ---- Anthropic's non-streaming response shape (subset we use) ----
interface AnthropicMessageResponse {
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

// ---- Anthropic's streaming event shapes (subset we use) ----
type AnthropicStreamEvent =
  | { type: "message_start"; message: { usage: { input_tokens: number; output_tokens: number } } }
  | {
      type: "content_block_start";
      index: number;
      content_block:
        { type: "text"; text: string } | { type: "tool_use"; id: string; name: string };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: string | null };
      usage: { output_tokens: number };
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly capabilities: ProviderCapabilities = {
    supportsParallelToolCalls: true,
    supportsVision: true,
    supportsStreaming: true,
  };
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly timeoutMs: number;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const { signal, cleanup } = this.combineSignals(options.signal);

    let response: Response;
    try {
      response = await fetch(`${this.baseURL}/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.buildRequestBody(options, false)),
        signal,
      });
    } catch (err) {
      throw this.mapFetchError(err);
    } finally {
      cleanup();
    }

    if (!response.ok) {
      throw await mapAnthropicError(response);
    }

    const body = (await response.json()) as AnthropicMessageResponse;
    const { text, toolCalls } = fromAnthropicContent(body.content);

    return {
      content: text,
      toolCalls,
      finishReason: mapAnthropicFinishReason(body.stop_reason),
      usage: mapUsage(body.usage),
      raw: body,
    };
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const { signal, cleanup } = this.combineSignals(options.signal);

    let response: Response;
    try {
      response = await fetch(`${this.baseURL}/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.buildRequestBody(options, true)),
        signal,
      });
    } catch (err) {
      cleanup();
      throw this.mapFetchError(err);
    }

    if (!response.ok || !response.body) {
      cleanup();
      throw await mapAnthropicError(response);
    }

    // Tracks in-progress content blocks by index — Anthropic streams tool
    // call arguments as incremental JSON-string deltas (`input_json_delta`)
    // that must be accumulated and parsed once the block closes.
    const blockState = new Map<
      number,
      { type: "text" } | { type: "tool_use"; id: string; name: string; argsJson: string }
    >();
    let finishReason: FinishReason = "stop";
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    try {
      for await (const raw of parseSSE(response.body)) {
        const event = raw as AnthropicStreamEvent;

        switch (event.type) {
          case "message_start":
            usage = mapUsage({
              input_tokens: event.message.usage.input_tokens,
              output_tokens: event.message.usage.output_tokens,
            });
            break;

          case "content_block_start":
            if (event.content_block.type === "text") {
              blockState.set(event.index, { type: "text" });
            } else {
              blockState.set(event.index, {
                type: "tool_use",
                id: event.content_block.id,
                name: event.content_block.name,
                argsJson: "",
              });
              yield {
                type: "tool_call_start",
                id: event.content_block.id,
                name: event.content_block.name,
              };
            }
            break;

          case "content_block_delta": {
            const state = blockState.get(event.index);
            if (event.delta.type === "text_delta") {
              yield { type: "text_delta", text: event.delta.text };
            } else if (event.delta.type === "input_json_delta" && state?.type === "tool_use") {
              state.argsJson += event.delta.partial_json;
              yield { type: "tool_call_delta", id: state.id, argsDelta: event.delta.partial_json };
            }
            break;
          }

          case "content_block_stop": {
            const state = blockState.get(event.index);
            if (state?.type === "tool_use") {
              yield { type: "tool_call_end", id: state.id };
            }
            break;
          }

          case "message_delta":
            finishReason = mapAnthropicFinishReason(event.delta.stop_reason);
            usage = {
              ...usage,
              outputTokens: event.usage.output_tokens,
              totalTokens: usage.inputTokens + event.usage.output_tokens,
            };
            break;

          case "error":
            throw new ProviderError(event.error.message, {
              provider: "anthropic",
              cause: event.error,
            });

          default:
            break; // message_stop, ping — no action needed
        }
      }

      yield { type: "finish", finishReason, usage };
    } catch (err) {
      const mapped = this.mapFetchError(err);
      yield { type: "error", error: mapped };
      throw mapped;
    } finally {
      cleanup();
    }
  }

  private buildRequestBody(options: GenerateOptions, stream: boolean): Record<string, unknown> {
    return {
      model: options.model,
      messages: toAnthropicMessages(options.messages),
      ...(options.system ? { system: options.system } : {}),
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.tools && options.tools.length > 0
        ? { tools: toAnthropicTools(options.tools) }
        : {}),
      ...(options.toolChoice ? { tool_choice: mapToolChoice(options.toolChoice) } : {}),
      stream,
    };
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }

  private combineSignals(callerSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new TimeoutError("Request timed out", { provider: "anthropic" })),
      this.timeoutMs
    );

    const onCallerAbort = () =>
      controller.abort(new CancelledError("Request cancelled", { provider: "anthropic" }));
    callerSignal?.addEventListener("abort", onCallerAbort);

    const cleanup = () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };

    return { signal: controller.signal, cleanup };
  }

  private mapFetchError(err: unknown): Error {
    if (
      err instanceof TimeoutError ||
      err instanceof CancelledError ||
      err instanceof ProviderError
    )
      return err;
    if (err instanceof DOMException && err.name === "AbortError") {
      return new CancelledError("Request cancelled", { provider: "anthropic", cause: err });
    }
    if (err instanceof Error) {
      return new ProviderError(err.message, { provider: "anthropic", cause: err });
    }
    return new ProviderError("Unknown error during Anthropic request", {
      provider: "anthropic",
      cause: err,
    });
  }
}

function mapUsage(usage: { input_tokens: number; output_tokens: number }): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
  };
}

function mapToolChoice(choice: GenerateOptions["toolChoice"]): unknown {
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none") return undefined; // Anthropic has no explicit "none" — omit tool_choice and don't send tools instead
  if (typeof choice === "object") return { type: "tool", name: choice.toolName };
  return { type: "auto" };
}
