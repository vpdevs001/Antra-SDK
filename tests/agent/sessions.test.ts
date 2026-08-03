import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import {
  Antra,
  Agent,
  MockProvider,
  InMemorySessionStore,
  FileSessionStore,
} from "../../src/index.js";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

describe("Agent — memory & sessions", () => {
  it("default InMemorySessionStore shares history across separate run() calls with the same sessionId", async () => {
    const provider = new MockProvider({
      respond: (options) => {
        const sawPriorTurn = options.messages.some((m) => m.content === "My name is Sam.");
        return {
          content: sawPriorTurn ? "Your name is Sam." : "Nice to meet you.",
          toolCalls: [],
          finishReason: "stop",
          usage: ZERO_USAGE,
          raw: undefined,
        };
      },
    });
    const client = new Antra({ provider });
    const agent = Agent.builder().client(client).model("mock").instructions("Assistant.").build();

    await agent.run("My name is Sam.", { sessionId: "s1" });
    const second = await agent.run("What's my name?", { sessionId: "s1" });

    expect(second.content).toBe("Your name is Sam.");
  });

  it("different sessionIds on the same agent don't leak into each other", async () => {
    const provider = new MockProvider({
      respond: (options) => {
        const leaked = options.messages.some((m) => m.content === "My name is Sam.");
        return {
          content: leaked ? "LEAKED" : "no history here",
          toolCalls: [],
          finishReason: "stop",
          usage: ZERO_USAGE,
          raw: undefined,
        };
      },
    });
    const client = new Antra({ provider });
    const agent = Agent.builder().client(client).model("mock").instructions("Assistant.").build();

    await agent.run("My name is Sam.", { sessionId: "a" });
    const result = await agent.run("What's my name?", { sessionId: "b" });

    expect(result.content).toBe("no history here");
  });

  it("an explicitly configured sessionStore receives the persisted transcript", async () => {
    const store = new InMemorySessionStore();
    const provider = new MockProvider({
      respond: () => ({
        content: "ack",
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
      .instructions("Assistant.")
      .sessionStore(store)
      .build();

    await agent.run("Remember this.", { sessionId: "s2" });

    const stored = await store.getMessages("s2");
    expect(stored.length).toBe(2); // user turn + assistant turn
  });

  describe("FileSessionStore", () => {
    const dir = "/tmp/antra-vitest-sessions";
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("survives across separate store instances (simulated process restart)", async () => {
      const provider = new MockProvider({
        respond: (options) => {
          const sawPriorTurn = options.messages.some((m) => m.content === "I like tea.");
          return {
            content: sawPriorTurn ? "You like tea." : "Got it.",
            toolCalls: [],
            finishReason: "stop",
            usage: ZERO_USAGE,
            raw: undefined,
          };
        },
      });
      const client = new Antra({ provider });

      const store1 = new FileSessionStore({ dir });
      const agent1 = Agent.builder()
        .client(client)
        .model("mock")
        .instructions("Assistant.")
        .sessionStore(store1)
        .build();
      await agent1.run("I like tea.", { sessionId: "durable" });

      const store2 = new FileSessionStore({ dir });
      const agent2 = Agent.builder()
        .client(client)
        .model("mock")
        .instructions("Assistant.")
        .sessionStore(store2)
        .build();
      const result = await agent2.run("What do I like?", { sessionId: "durable" });

      expect(result.content).toBe("You like tea.");
    });

    it("rejects an unsafe sessionId rather than silently sanitizing it", async () => {
      const store = new FileSessionStore({ dir });
      await expect(store.setMessages("../../etc/passwd", [])).rejects.toThrow();
    });
  });
});
