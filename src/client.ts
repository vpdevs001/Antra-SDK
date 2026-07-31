import type { Provider } from "./core/provider.js";
import type { GenerateOptions, GenerateResult, StreamChunk, Message } from "./core/types.js";
import { OpenAIProvider } from "./providers/openai/provider.js";
import { InvalidRequestError } from "./errors/index.js";

export interface AntraConfig {
  apiKey: string;
  /** Which provider backend to use. Defaults to "openai" — more are added in Chapter 7. */
  provider?: "openai";
  baseURL?: string;
  timeoutMs?: number;
}

/** Per-call options, minus what's already fixed at the Client level. */
export type CallOptions = Omit<GenerateOptions, "messages"> & {
  messages: Message[];
};

/**
 * The main entrypoint. Construction takes an API key only (no env var
 * fallback, by design — explicit config over implicit magic).
 *
 * @example
 * const antra = new Antra({ apiKey: process.env.OPENAI_API_KEY! });
 * const result = await antra.generate({ model: "gpt-4o", messages: [...] });
 */
export class Antra {
  private readonly provider: Provider;

  constructor(config: AntraConfig) {
    if (!config.apiKey) {
      throw new InvalidRequestError("Antra: `apiKey` is required to construct a client.");
    }

    switch (config.provider ?? "openai") {
      case "openai":
        this.provider = new OpenAIProvider({
          apiKey: config.apiKey,
          ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
          ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        });
        break;
      default:
        throw new InvalidRequestError(`Antra: unknown provider "${config.provider}".`);
    }
  }

  /** Single-shot generation. Resolves once the full response is available. */
  generate(options: CallOptions): Promise<GenerateResult> {
    return this.provider.generate(options);
  }

  /** Streaming generation. Yields chunks as they arrive — use with `for await`. */
  stream(options: CallOptions): AsyncGenerator<StreamChunk, void, unknown> {
    return this.provider.stream(options);
  }
}
