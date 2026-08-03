import { describe, it, expect } from "vitest";
import { Antra } from "../../src/client.js";
import { FallbackProvider } from "../../src/providers/fallback.js";
import { MockProvider } from "../../src/providers/mock/provider.js";
import { RateLimitError, AuthError } from "../../src/errors/index.js";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

describe("FallbackProvider", () => {
  it("falls through to the next provider on a retryable error", async () => {
    const primary = new MockProvider({
      respond: () => {
        throw new RateLimitError("rate limited", { provider: "mock-primary" });
      },
    });
    const secondary = new MockProvider({
      respond: () => ({
        content: "Answered by fallback.",
        toolCalls: [],
        finishReason: "stop",
        usage: ZERO_USAGE,
        raw: undefined,
      }),
    });

    const client = new Antra({
      provider: new FallbackProvider([{ provider: primary }, { provider: secondary }]),
    });
    const result = await client.generate({
      model: "mock",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.content).toBe("Answered by fallback.");
    expect(primary.callCount).toBe(1);
    expect(secondary.callCount).toBe(1);
  });

  it("does NOT fall through on a non-retryable error", async () => {
    const primary = new MockProvider({
      respond: () => {
        throw new AuthError("invalid key", { provider: "mock-primary" });
      },
    });
    const secondary = new MockProvider({
      respond: () => ({
        content: "should never be reached",
        toolCalls: [],
        finishReason: "stop",
        usage: ZERO_USAGE,
        raw: undefined,
      }),
    });

    const client = new Antra({
      provider: new FallbackProvider([{ provider: primary }, { provider: secondary }]),
    });

    await expect(
      client.generate({ model: "mock", messages: [{ role: "user", content: "hi" }] })
    ).rejects.toThrow(AuthError);
    expect(secondary.callCount).toBe(0);
  });

  it("reports a capability as true only if every provider in the chain supports it", () => {
    const limited = new MockProvider();
    Object.defineProperty(limited, "capabilities", {
      value: { supportsParallelToolCalls: true, supportsVision: false, supportsStreaming: true },
    });
    const full = new MockProvider();

    const fallback = new FallbackProvider([{ provider: full }, { provider: limited }]);
    expect(fallback.capabilities.supportsVision).toBe(false);
    expect(fallback.capabilities.supportsParallelToolCalls).toBe(true);
  });

  it("each entry can override the model used for that provider", async () => {
    const primary = new MockProvider({
      respond: () => {
        throw new RateLimitError("rate limited");
      },
    });
    const secondary = new MockProvider({
      respond: (options) => ({
        content: `model was ${options.model}`,
        toolCalls: [],
        finishReason: "stop",
        usage: ZERO_USAGE,
        raw: undefined,
      }),
    });

    const client = new Antra({
      provider: new FallbackProvider([
        { provider: primary, model: "primary-model" },
        { provider: secondary, model: "secondary-model" },
      ]),
    });

    const result = await client.generate({
      model: "primary-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.content).toBe("model was secondary-model");
  });
});
