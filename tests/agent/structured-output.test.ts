import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Antra, Agent, MockProvider, OutputValidationError } from "../../src/index.js";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const PersonSchema = z.object({ name: z.string(), age: z.number() });

describe("Agent — structured output", () => {
  it("valid JSON on the first try produces typed output", async () => {
    const provider = new MockProvider({
      respond: () => ({
        content: '{"name":"Ada","age":36}',
        toolCalls: [],
        finishReason: "stop",
        usage: ZERO_USAGE,
        raw: undefined,
      }),
    });
    const client = new Antra({ provider });
    const agent = Agent.builder()
      .client(client)
      .model("mock")
      .instructions("Extract person info.")
      .build();

    const result = await agent.run("Ada is 36.", { outputSchema: PersonSchema });

    expect(result.output.name).toBe("Ada");
    expect(result.output.age).toBe(36);
    expect(result.finishReason).toBe("stop");
  });

  it("self-repairs after an invalid first attempt", async () => {
    let call = 0;
    const provider = new MockProvider({
      respond: () => {
        call++;
        if (call === 1)
          return {
            content: '{"name":"Grace"}',
            toolCalls: [],
            finishReason: "stop",
            usage: ZERO_USAGE,
            raw: undefined,
          }; // missing age
        return {
          content: '{"name":"Grace","age":45}',
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
      .instructions("Extract person info.")
      .onEvent((e) => events.push(e.type))
      .build();

    const result = await agent.run("Grace is 45.", { outputSchema: PersonSchema });

    expect(result.output).toEqual({ name: "Grace", age: 45 });
    expect(events).toContain("output_repair_attempted");
    expect(provider.callCount).toBe(2);
  });

  it("throws OutputValidationError once repair attempts are exhausted", async () => {
    const provider = new MockProvider({
      respond: () => ({
        content: "not json at all",
        toolCalls: [],
        finishReason: "stop",
        usage: ZERO_USAGE,
        raw: undefined,
      }),
    });
    const client = new Antra({ provider });
    const agent = Agent.builder()
      .client(client)
      .model("mock")
      .instructions("Extract person info.")
      .build();

    await expect(
      agent.run("Whoever.", { outputSchema: PersonSchema, maxRepairAttempts: 2 })
    ).rejects.toThrow(OutputValidationError);
    // 1 initial + 2 repairs = 3 calls total.
    expect(provider.callCount).toBe(3);
  });
});
