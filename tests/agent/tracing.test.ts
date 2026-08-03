import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Antra, Agent, defineTool, MockProvider, AuthError } from "../../src/index.js";
import { RateLimitError } from "../../src/errors/index.js";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

describe("Agent — tracing & reliability", () => {
  it("retries a transient error and records it in the trace + as an event", async () => {
    let call = 0;
    const provider = new MockProvider({
      respond: () => {
        call++;
        if (call === 1) throw new RateLimitError("rate limited");
        return {
          content: "Recovered.",
          toolCalls: [],
          finishReason: "stop",
          usage: ZERO_USAGE,
          raw: undefined,
        };
      },
    });
    const client = new Antra({ provider });
    const events: string[] = [];
    const agent = Agent.builder()
      .client(client)
      .model("mock")
      .instructions("A")
      .retry({ initialDelayMs: 1, maxDelayMs: 5 })
      .onEvent((e) => events.push(e.type))
      .build();

    const result = await agent.run("Hello");

    expect(result.content).toBe("Recovered.");
    expect(events).toContain("retry_attempted");
    expect(result.trace.retries.length).toBe(1);
    expect(result.trace.modelCalls[0]?.retries).toBe(1);
  });

  it("does not retry a non-retryable error", async () => {
    const provider = new MockProvider({
      respond: () => {
        throw new AuthError("bad key");
      },
    });
    const client = new Antra({ provider });
    const agent = Agent.builder()
      .client(client)
      .model("mock")
      .instructions("A")
      .retry({ initialDelayMs: 1 })
      .build();

    await expect(agent.run("Hello")).rejects.toThrow(AuthError);
    expect(provider.callCount).toBe(1);
  });

  it("maxTokens stops the run gracefully with finishReason 'limit_exceeded'", async () => {
    const noop = defineTool({
      name: "noop",
      description: "no-op",
      schema: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const provider = new MockProvider({
      respond: () => ({
        content: "",
        toolCalls: [{ id: "x", name: "noop", args: {} }],
        finishReason: "tool_calls",
        usage: { inputTokens: 5000, outputTokens: 5000, totalTokens: 10000 },
        raw: undefined,
      }),
    });
    const client = new Antra({ provider });
    const agent = Agent.builder()
      .client(client)
      .model("mock")
      .instructions("A")
      .tool(noop)
      .maxTokens(15000)
      .maxSteps(20)
      .build();

    const result = await agent.run("Go");
    expect(result.finishReason).toBe("limit_exceeded");
  });

  it("maxDurationMs stops the run gracefully with finishReason 'limit_exceeded'", async () => {
    const noop = defineTool({
      name: "noop",
      description: "no-op",
      schema: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const provider = new MockProvider({
      respond: () => ({
        content: "",
        toolCalls: [{ id: "x", name: "noop", args: {} }],
        finishReason: "tool_calls",
        usage: ZERO_USAGE,
        raw: undefined,
      }),
    });
    const client = new Antra({ provider });
    const agent = Agent.builder()
      .client(client)
      .model("mock")
      .instructions("A")
      .tool(noop)
      .maxDurationMs(1)
      .maxSteps(1000)
      .build();

    const result = await agent.run("Go");
    expect(result.finishReason).toBe("limit_exceeded");
  });

  it("trace.totalUsage accumulates across every model call in the run", async () => {
    let call = 0;
    const noop = defineTool({
      name: "noop",
      description: "no-op",
      schema: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const provider = new MockProvider({
      respond: () => {
        call++;
        if (call === 1)
          return {
            content: "",
            toolCalls: [{ id: "x", name: "noop", args: {} }],
            finishReason: "tool_calls",
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            raw: undefined,
          };
        return {
          content: "Done.",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
          raw: undefined,
        };
      },
    });
    const client = new Antra({ provider });
    const agent = Agent.builder().client(client).model("mock").instructions("A").tool(noop).build();

    const result = await agent.run("Go");
    expect(result.trace.totalUsage).toEqual({ inputTokens: 30, outputTokens: 10, totalTokens: 40 });
    expect(result.trace.modelCalls.length).toBe(2);
  });
});
