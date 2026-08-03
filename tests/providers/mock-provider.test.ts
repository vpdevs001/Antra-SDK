import { describe, it, expect } from "vitest";
import { MockProvider, sequence } from "../../src/providers/mock/provider.js";
import type { GenerateResult } from "../../src/core/types.js";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

describe("MockProvider", () => {
  it("returns a fixed default response with no config", async () => {
    const provider = new MockProvider();
    const result = await provider.generate({
      model: "mock",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.content).toBe("Mock response.");
    expect(result.finishReason).toBe("stop");
  });

  it("records every request for later assertions", async () => {
    const provider = new MockProvider();
    await provider.generate({ model: "mock", messages: [{ role: "user", content: "first" }] });
    await provider.generate({ model: "mock", messages: [{ role: "user", content: "second" }] });

    expect(provider.callCount).toBe(2);
    expect(provider.requests[0]?.messages[0]).toMatchObject({ content: "first" });
    expect(provider.requests[1]?.messages[0]).toMatchObject({ content: "second" });
  });

  it("respond() receives the request and call index, so behavior can vary per call", async () => {
    const provider = new MockProvider({
      respond: (_options, callIndex) => ({
        content: `call ${callIndex}`,
        toolCalls: [],
        finishReason: "stop",
        usage: ZERO_USAGE,
        raw: undefined,
      }),
    });

    const first = await provider.generate({ model: "mock", messages: [] });
    const second = await provider.generate({ model: "mock", messages: [] });
    expect(first.content).toBe("call 0");
    expect(second.content).toBe("call 1");
  });

  it("sequence() cycles through canned results, repeating the last one past the end", async () => {
    const resultA: GenerateResult = {
      content: "A",
      toolCalls: [],
      finishReason: "stop",
      usage: ZERO_USAGE,
      raw: undefined,
    };
    const resultB: GenerateResult = {
      content: "B",
      toolCalls: [],
      finishReason: "stop",
      usage: ZERO_USAGE,
      raw: undefined,
    };
    const provider = new MockProvider({ respond: sequence([resultA, resultB]) });

    expect((await provider.generate({ model: "mock", messages: [] })).content).toBe("A");
    expect((await provider.generate({ model: "mock", messages: [] })).content).toBe("B");
    expect((await provider.generate({ model: "mock", messages: [] })).content).toBe("B"); // repeats last
  });

  it("stream() synthesizes text_delta, tool_call_*, and finish chunks from the same result shape as generate()", async () => {
    const provider = new MockProvider({
      respond: () => ({
        content: "Here you go",
        toolCalls: [{ id: "call_1", name: "get_weather", args: { city: "Paris" } }],
        finishReason: "tool_calls",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        raw: undefined,
      }),
    });

    const chunks = [];
    for await (const chunk of provider.stream({ model: "mock", messages: [] })) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.type)).toEqual([
      "text_delta",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "finish",
    ]);
    const toolStart = chunks.find((c) => c.type === "tool_call_start");
    expect(toolStart).toMatchObject({ id: "call_1", name: "get_weather" });
  });
});
