import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Antra, Agent, defineTool, MockProvider, sequence } from "../../src/index.js";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

describe("Agent — core tool-calling loop", () => {
  it("executes a tool call and produces a final answer, via native tool-calling (no hand-parsed JSON)", async () => {
    const getWeather = defineTool({
      name: "get_weather",
      description: "Get weather for a city",
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, tempC: 22, condition: "sunny" }),
    });

    const provider = new MockProvider({
      respond: sequence([
        {
          content: "",
          toolCalls: [{ id: "call_1", name: "get_weather", args: { city: "Paris" } }],
          finishReason: "tool_calls",
          usage: ZERO_USAGE,
          raw: undefined,
        },
        {
          content: "It's 22°C and sunny in Paris.",
          toolCalls: [],
          finishReason: "stop",
          usage: ZERO_USAGE,
          raw: undefined,
        },
      ]),
    });

    const client = new Antra({ provider });
    const events: string[] = [];
    const agent = Agent.builder()
      .client(client)
      .model("mock")
      .instructions("Weather assistant.")
      .tool(getWeather)
      .onEvent((e) => events.push(e.type))
      .build();

    const result = await agent.run("Weather in Paris?");

    expect(result.content).toBe("It's 22°C and sunny in Paris.");
    expect(result.finishReason).toBe("stop");
    expect(result.steps).toBe(2);
    expect(events).toEqual([
      "step_start",
      "model_response",
      "tool_call_start",
      "tool_call_end",
      "step_start",
      "model_response",
      "finish",
    ]);
  });

  it("invalid tool arguments produce a ToolExecutionError result fed back to the model, without crashing the run", async () => {
    const strictTool = defineTool({
      name: "set_age",
      description: "Set a person's age",
      schema: z.object({ age: z.number() }),
      execute: async ({ age }) => ({ age }),
    });

    const provider = new MockProvider({
      respond: sequence([
        {
          content: "",
          toolCalls: [{ id: "call_1", name: "set_age", args: { age: "not-a-number" } }],
          finishReason: "tool_calls",
          usage: ZERO_USAGE,
          raw: undefined,
        },
        {
          content: "Sorry, I couldn't process that.",
          toolCalls: [],
          finishReason: "stop",
          usage: ZERO_USAGE,
          raw: undefined,
        },
      ]),
    });

    const client = new Antra({ provider });
    const agent = Agent.builder()
      .client(client)
      .model("mock")
      .instructions("Assistant.")
      .tool(strictTool)
      .build();
    const result = await agent.run("Set age to banana");

    expect(result.finishReason).toBe("stop");
    expect(result.content).toBe("Sorry, I couldn't process that.");
    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(JSON.stringify(toolMessage)).toContain("Invalid arguments");
  });

  it("a tool that throws is caught and reported back as a tool_result, not an unhandled rejection", async () => {
    const flaky = defineTool({
      name: "flaky",
      description: "Always fails",
      schema: z.object({}),
      execute: async () => {
        throw new Error("boom");
      },
    });

    const provider = new MockProvider({
      respond: sequence([
        {
          content: "",
          toolCalls: [{ id: "call_1", name: "flaky", args: {} }],
          finishReason: "tool_calls",
          usage: ZERO_USAGE,
          raw: undefined,
        },
        {
          content: "That didn't work.",
          toolCalls: [],
          finishReason: "stop",
          usage: ZERO_USAGE,
          raw: undefined,
        },
      ]),
    });

    const client = new Antra({ provider });
    const agent = Agent.builder()
      .client(client)
      .model("mock")
      .instructions("Assistant.")
      .tool(flaky)
      .build();
    const result = await agent.run("Do the flaky thing");

    expect(result.finishReason).toBe("stop");
    expect(result.content).toBe("That didn't work.");
  });

  it("stops with finishReason 'max_steps' if the model keeps calling tools forever", async () => {
    const noop = defineTool({
      name: "noop",
      description: "no-op",
      schema: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const provider = new MockProvider({
      respond: () => ({
        content: "",
        toolCalls: [{ id: "call_x", name: "noop", args: {} }],
        finishReason: "tool_calls",
        usage: ZERO_USAGE,
        raw: undefined,
      }),
    });

    const client = new Antra({ provider });
    const agent = Agent.builder()
      .client(client)
      .model("mock")
      .instructions("Assistant.")
      .tool(noop)
      .maxSteps(3)
      .build();
    const result = await agent.run("Loop forever");

    expect(result.finishReason).toBe("max_steps");
    expect(result.steps).toBe(3);
  });

  it("run() resolves with finishReason 'aborted' when cancelled via AbortController", async () => {
    const provider = new MockProvider({
      respond: () => ({
        content: "should not matter",
        toolCalls: [],
        finishReason: "stop",
        usage: ZERO_USAGE,
        raw: undefined,
      }),
    });
    const client = new Antra({ provider });
    const agent = Agent.builder().client(client).model("mock").instructions("Assistant.").build();

    const controller = new AbortController();
    controller.abort();
    const result = await agent.run("Hello", { signal: controller.signal });

    expect(result.finishReason).toBe("aborted");
  });
});
