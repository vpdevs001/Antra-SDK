import type { GenerateOptions, GenerateResult, StreamChunk } from "./types.js";

/**
 * Every provider (OpenAI, Anthropic, Google, ...) implements this interface.
 * The Client class (see client.ts) delegates to whichever provider the user
 * selects, so the public API never changes regardless of backend.
 */
export interface Provider {
  /** Short identifier used in error messages, e.g. "openai". */
  readonly name: string;

  /** Non-streaming generation. Resolves once the full response is available. */
  generate(options: GenerateOptions): Promise<GenerateResult>;

  /** Streaming generation. Yields chunks as they arrive from the provider. */
  stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown>;

  /**
   * Optional: embeddings support. Not every provider/model supports this,
   * so it's optional on the interface — the Client throws a clear error
   * if a user calls `.embed()` on a provider that doesn't implement it.
   */
  embed?(input: string | string[], model: string): Promise<number[][]>;
}
