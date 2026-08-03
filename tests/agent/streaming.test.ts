import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  Antra,
  Agent,
  defineTool,
  MockProvider,
  sequence,
  GuardrailError,
} from "../../src/index.js";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

const noop = defineTool({
  name: "noop",
  description: "no-op",
  schema: z.object({}),
  execute: async () => ({ ok: true }),
});

describe("Agent — streaming & events", () => {
  it("stream() and onEvent() produce identical event sequences for the same run", async () => {
    const responses = sequence([
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "noop", args: {} }],
        finishReason: "tool_calls",
        usage: ZERO_USAGE,
        raw: undefined,
      },
      { content: "Done.", toolCalls: [], finishReason: "stop", usage: ZERO_USAGE, raw: undefined },
    ]);

    const client1 = new Antra({ provider: new MockProvider({ respond: responses }) });
    const eventsViaCallback: string[] = [];
    const agent1 = Agent.builder()
      .client(client1)
      .model("mock")
      .instructions("A")
      .tool(noop)
      .onEvent((e) => eventsViaCallback.push(e.type))
      .build();
    await agent1.run("Do the thing.", { streamText: true }); // same transport as stream() below, for an honest comparison

    const client2 = new Antra({ provider: new MockProvider({ respond: responses }) });
    const eventsViaStream: string[] = [];
    const agent2 = Agent.builder()
      .client(client2)
      .model("mock")
      .instructions("A")
      .tool(noop)
      .build();
    for await (const event of agent2.stream("Do the thing.")) {
      eventsViaStream.push(event.type);
    }

    expect(eventsViaStream).toEqual(eventsViaCallback);
  });

  it("real streaming (streamText: true) yields text_delta events reconstructing the full content", async () => {
    const provider = new MockProvider({
      respond: () => ({
        content: "Hello there!",
        toolCalls: [],
        finishReason: "stop",
        usage: ZERO_USAGE,
        raw: undefined,
      }),
    });
    const client = new Antra({ provider });
    const agent = Agent.builder().client(client).model("mock").instructions("A").build();

    const deltas: string[] = [];
    agent.onEvent((e) => {
      if (e.type === "text_delta") deltas.push(e.text);
    });

    const result = await agent.run("Say hi.", { streamText: true });
    expect(deltas.join("")).toBe("Hello there!");
    expect(result.content).toBe("Hello there!");
  });

  it("errors thrown inside run() propagate through the async iterator", async () => {
    const provider = new MockProvider();
    const client = new Antra({ provider });
    const agent = Agent.builder()
      .client(client)
      .model("mock")
      .instructions("A")
      .inputGuardrail(() => ({ passed: false, reason: "blocked" }), { mode: "strict" })
      .build();

    const iterate = async () => {
      for await (const _event of agent.stream("test")) {
        // drain
      }
    };

    await expect(iterate()).rejects.toThrow(GuardrailError);
  });
});
