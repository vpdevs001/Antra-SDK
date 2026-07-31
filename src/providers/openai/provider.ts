import type { Provider } from "../../core/provider.js";
import type {
  GenerateOptions,
  GenerateResult,
  StreamChunk,
  FinishReason,
  Usage,
} from "../../core/types.js";
import {
  toOpenAIMessages,
  toOpenAITools,
  fromOpenAIToolCalls,
  type OpenAIToolCall,
} from "./mapping.js";
import { mapOpenAIError } from "./errors.js";
import { parseSSE } from "../../streaming/sse.js";
import { TimeoutError, CancelledError, ProviderError } from "../../errors/index.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAIProviderConfig {
  apiKey: string;
  baseURL?: string;
  /** Request timeout in ms. Applies per-request, separate from any AbortSignal the caller passes. */
  timeoutMs?: number;
}

// ---- OpenAI's non-streaming response shape (subset we use) ----
interface OpenAIChatCompletion {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---- OpenAI's streaming chunk shape (subset we use) ----
interface OpenAIStreamChunk {
  choices: Array<{
    delta: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

export class OpenAIProvider implements Provider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly timeoutMs: number;

  constructor(config: OpenAIProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const { signal, cleanup } = this.combineSignals(options.signal);

    let response: Response;
    try {
      response = await fetch(`${this.baseURL}/chat/completions`, {
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
      throw await mapOpenAIError(response);
    }

    const body = (await response.json()) as OpenAIChatCompletion;
    const choice = body.choices[0];
    if (!choice) {
      throw new ProviderError("OpenAI response contained no choices", {
        provider: "openai",
        cause: body,
      });
    }

    return {
      content: choice.message.content ?? "",
      toolCalls: fromOpenAIToolCalls(choice.message.tool_calls),
      finishReason: mapFinishReason(choice.finish_reason),
      usage: mapUsage(body.usage),
      raw: body,
    };
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const { signal, cleanup } = this.combineSignals(options.signal);

    let response: Response;
    try {
      response = await fetch(`${this.baseURL}/chat/completions`, {
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
      throw await mapOpenAIError(response);
    }

    // Accumulates in-progress tool call args across deltas, keyed by OpenAI's per-chunk `index`
    // (OpenAI streams tool calls by index, not id — the id only arrives in the first delta).
    const toolCallState = new Map<number, { id: string; name: string; started: boolean }>();
    let finishReason: FinishReason = "stop";
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    try {
      for await (const raw of parseSSE(response.body)) {
        const chunk = raw as OpenAIStreamChunk;
        const choice = chunk.choices[0];

        if (chunk.usage) {
          usage = mapUsage(chunk.usage);
        }

        if (!choice) continue;

        if (choice.delta.content) {
          yield { type: "text_delta", text: choice.delta.content };
        }

        for (const tc of choice.delta.tool_calls ?? []) {
          const existing = toolCallState.get(tc.index);

          if (!existing && tc.id && tc.function?.name) {
            toolCallState.set(tc.index, { id: tc.id, name: tc.function.name, started: true });
            yield { type: "tool_call_start", id: tc.id, name: tc.function.name };
          }

          const state = toolCallState.get(tc.index);
          if (state && tc.function?.arguments) {
            yield { type: "tool_call_delta", id: state.id, argsDelta: tc.function.arguments };
          }
        }

        if (choice.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
      }

      for (const state of toolCallState.values()) {
        yield { type: "tool_call_end", id: state.id };
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
      messages: toOpenAIMessages(options.messages, options.system),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options.tools && options.tools.length > 0 ? { tools: toOpenAITools(options.tools) } : {}),
      ...(options.toolChoice ? { tool_choice: mapToolChoice(options.toolChoice) } : {}),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  /**
   * Combines the caller's AbortSignal (if any) with an internal timeout,
   * so both cancellation and timeouts are exposed as the same fetch signal,
   * but distinguishable afterwards via `mapFetchError`.
   */
  private combineSignals(callerSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new TimeoutError("Request timed out", { provider: "openai" })),
      this.timeoutMs
    );

    const onCallerAbort = () =>
      controller.abort(new CancelledError("Request cancelled", { provider: "openai" }));
    callerSignal?.addEventListener("abort", onCallerAbort);

    const cleanup = () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };

    return { signal: controller.signal, cleanup };
  }

  private mapFetchError(err: unknown): Error {
    if (err instanceof TimeoutError || err instanceof CancelledError) return err;
    if (err instanceof DOMException && err.name === "AbortError") {
      return new CancelledError("Request cancelled", { provider: "openai", cause: err });
    }
    if (err instanceof Error) {
      return new ProviderError(err.message, { provider: "openai", cause: err });
    }
    return new ProviderError("Unknown error during OpenAI request", {
      provider: "openai",
      cause: err,
    });
  }
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

function mapUsage(usage: OpenAIChatCompletion["usage"]): Usage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
  };
}

function mapToolChoice(choice: GenerateOptions["toolChoice"]): unknown {
  if (choice === "auto" || choice === "none") return choice;
  if (choice === "required") return "required";
  if (typeof choice === "object") {
    return { type: "function", function: { name: choice.toolName } };
  }
  return "auto";
}
