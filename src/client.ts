import type { Provider } from "./core/provider.js";
import type { GenerateOptions, GenerateResult, StreamChunk, Message } from "./core/types.js";
import { OpenAIProvider } from "./providers/openai/provider.js";
import { AnthropicProvider } from "./providers/anthropic/provider.js";
import { FallbackProvider, type FallbackEntry } from "./providers/fallback.js";
import { InvalidRequestError } from "./errors/index.js";

export type ProviderName = "openai" | "anthropic";

interface BaseProviderConfig {
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
}

/** One entry in a fallback chain — a provider to try, with an optional model override for it. */
export interface ProviderSpec extends BaseProviderConfig {
  provider: ProviderName;
  /** Model to use when falling back to this provider (model IDs differ per provider). */
  model?: string;
}

/** Single-provider config — the common case, unchanged shape from Chapter 2 plus a provider choice. */
export interface SingleProviderConfig extends BaseProviderConfig {
  /** Which provider backend to use. Defaults to "openai". */
  provider?: ProviderName;
}

/** Fallback-chain config — tries each provider in order on retryable failures. */
export interface FallbackConfig {
  providers: ProviderSpec[];
}

/**
 * Direct-injection config — pass any object implementing the `Provider`
 * interface (e.g. `MockProvider` for testing, or your own custom
 * provider). No `apiKey` involved here; whatever you pass in owns its
 * own auth, if it needs any.
 */
export interface CustomProviderConfig {
  provider: Provider;
}

export type AntraConfig = SingleProviderConfig | FallbackConfig | CustomProviderConfig;

function isFallbackConfig(config: AntraConfig): config is FallbackConfig {
  return "providers" in config;
}

function isCustomProviderConfig(config: AntraConfig): config is CustomProviderConfig {
  return "provider" in config && typeof config.provider === "object";
}

/** Per-call options, minus what's already fixed at the Client level. */
export type CallOptions = Omit<GenerateOptions, "messages"> & {
  messages: Message[];
};

function createProvider(spec: { provider: ProviderName } & BaseProviderConfig): Provider {
  const opts = {
    apiKey: spec.apiKey,
    ...(spec.baseURL !== undefined ? { baseURL: spec.baseURL } : {}),
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
  };

  switch (spec.provider) {
    case "openai":
      return new OpenAIProvider(opts);
    case "anthropic":
      return new AnthropicProvider(opts);
    default:
      throw new InvalidRequestError(`Antra: unknown provider "${spec.provider}".`);
  }
}

/**
 * The main entrypoint. Two ways to construct it:
 *
 * @example Single provider (the common case)
 * const antra = new Antra({ apiKey: process.env.OPENAI_API_KEY! });
 *
 * @example Fallback chain — tries each provider in order on retryable failures
 * const antra = new Antra({
 *   providers: [
 *     { provider: "openai", apiKey: OPENAI_KEY, model: "gpt-4o" },
 *     { provider: "anthropic", apiKey: ANTHROPIC_KEY, model: "claude-3-5-sonnet-latest" },
 *   ],
 * });
 *
 * @example Testing — inject a MockProvider directly, no API key or network involved
 * const antra = new Antra({ provider: new MockProvider({ respond: () => myFixture }) });
 */
export class Antra {
  private readonly provider: Provider;

  constructor(config: AntraConfig) {
    if (isCustomProviderConfig(config)) {
      this.provider = config.provider;
      return;
    }

    if (isFallbackConfig(config)) {
      if (config.providers.length === 0) {
        throw new InvalidRequestError("Antra: `providers` must contain at least one entry.");
      }
      const entries: FallbackEntry[] = config.providers.map((spec) => ({
        provider: createProvider(spec),
        ...(spec.model !== undefined ? { model: spec.model } : {}),
      }));
      this.provider = new FallbackProvider(entries);
      return;
    }

    if (!config.apiKey) {
      throw new InvalidRequestError("Antra: `apiKey` is required to construct a client.");
    }
    this.provider = createProvider({ provider: config.provider ?? "openai", ...config });
  }

  /** Which capabilities the underlying provider(s) support. */
  get capabilities() {
    return this.provider.capabilities;
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
