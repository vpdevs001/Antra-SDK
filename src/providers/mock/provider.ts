import type { Provider, ProviderCapabilities } from "../../core/provider.js";
import type { GenerateOptions, GenerateResult, StreamChunk } from "../../core/types.js";

export type MockResponder = (options: GenerateOptions, callIndex: number) => GenerateResult;

export interface MockProviderConfig {
  /**
   * Called for every generate()/stream() call to produce the canned
   * response. Receives the actual request (so tests can assert on what
   * was sent) and the zero-based call index (so tests can vary behavior
   * across a multi-step agent loop — e.g. return a tool call on the
   * first call, a final answer on the second).
   *
   * Defaults to always returning a fixed "Mock response." with no tool
   * calls if not provided.
   */
  respond?: MockResponder;
}

const DEFAULT_RESULT: GenerateResult = {
  content: "Mock response.",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  raw: undefined,
};

/**
 * A Provider implementation with no network calls at all — for unit
 * testing agents (yours, or ones built with Antra) with zero cost and
 * full determinism. Implements the exact same `Provider` interface as
 * `OpenAIProvider`/`AnthropicProvider`, so anywhere a real provider
 * works, this is a drop-in replacement.
 *
 * @example
 * const provider = new MockProvider({
 *   respond: (options, callIndex) =>
 *     callIndex === 0
 *       ? { content: "", toolCalls: [{ id: "1", name: "get_weather", args: { city: "Paris" } }], finishReason: "tool_calls", usage: ZERO_USAGE, raw: undefined }
 *       : { content: "It's sunny.", toolCalls: [], finishReason: "stop", usage: ZERO_USAGE, raw: undefined },
 * });
 * const client = new Antra({ provider });
 * const agent = Agent.builder().client(client).model("mock").tool(getWeather).build();
 */
export class MockProvider implements Provider {
  readonly name = "mock";
  readonly capabilities: ProviderCapabilities = {
    supportsParallelToolCalls: true,
    supportsVision: true,
    supportsStreaming: true,
  };

  private readonly respond: MockResponder;
  private readonly calls: GenerateOptions[] = [];

  constructor(config: MockProviderConfig = {}) {
    this.respond = config.respond ?? (() => DEFAULT_RESULT);
  }

  /** Every request this provider has received so far, in order — for asserting on what an agent actually sent. */
  get requests(): readonly GenerateOptions[] {
    return this.calls;
  }

  /** Number of generate()/stream() calls made so far. */
  get callCount(): number {
    return this.calls.length;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const callIndex = this.calls.length;
    this.calls.push(options);
    return this.respond(options, callIndex);
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const callIndex = this.calls.length;
    this.calls.push(options);
    const result = this.respond(options, callIndex);

    if (result.content) {
      yield { type: "text_delta", text: result.content };
    }
    for (const toolCall of result.toolCalls) {
      yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
      yield { type: "tool_call_delta", id: toolCall.id, argsDelta: JSON.stringify(toolCall.args) };
      yield { type: "tool_call_end", id: toolCall.id };
    }
    yield { type: "finish", finishReason: result.finishReason, usage: result.usage };
  }
}

/**
 * Convenience helper: builds a MockResponder from a plain array of
 * canned results, returned in order (repeating the last one if more
 * calls happen than results provided). Covers the common case without
 * needing to write the callIndex-switching logic by hand.
 *
 * @example
 * new MockProvider({ respond: sequence([toolCallResult, finalAnswerResult]) })
 */
export function sequence(results: GenerateResult[]): MockResponder {
  return (_options, callIndex) =>
    results[callIndex] ?? results[results.length - 1] ?? DEFAULT_RESULT;
}
