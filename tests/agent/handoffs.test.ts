import { describe, it, expect } from "vitest";
import { Antra, Agent, MockProvider, HandoffError } from "../../src/index.js";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

describe("Agent — handoffs", () => {
  it("router delegates to a specialist, preserving context and reporting handoffChain", async () => {
    let call = 0;
    const provider = new MockProvider({
      respond: (options) => {
        call++;
        if (call === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "call_1",
                name: "handoff_to_billing-specialist",
                args: { reason: "billing question" },
              },
            ],
            finishReason: "tool_calls",
            usage: ZERO_USAGE,
            raw: undefined,
          };
        }
        const gotOriginalContext = options.messages.some((m) => m.content === "I want a refund.");
        return {
          content: gotOriginalContext ? "Refund processed." : "MISSING CONTEXT",
          toolCalls: [],
          finishReason: "stop",
          usage: ZERO_USAGE,
          raw: undefined,
        };
      },
    });

    const client = new Antra({ provider });
    const specialist = Agent.builder()
      .client(client)
      .model("mock")
      .name("billing-specialist")
      .instructions("Handles billing.")
      .build();
    const router = Agent.builder()
      .client(client)
      .model("mock")
      .name("router")
      .instructions("Routes billing questions.")
      .handoffs([specialist])
      .build();

    const events: string[] = [];
    router.onEvent((e) => events.push(e.type));

    const result = await router.run("I want a refund.");

    expect(result.content).toBe("Refund processed.");
    expect(result.handoffChain).toEqual(["router", "billing-specialist"]);
    expect(events).toContain("handoff_started");
    expect(events).toContain("handoff_completed");
  });

  it("a cyclic handoff configuration is caught by maxHandoffDepth, not left to hang", async () => {
    let call = 0;
    const provider = new MockProvider({
      respond: () => {
        const target = call % 2 === 0 ? "agent-b" : "agent-a";
        call++;
        return {
          content: "",
          toolCalls: [
            { id: `call_${call}`, name: `handoff_to_${target}`, args: { reason: "passing along" } },
          ],
          finishReason: "tool_calls",
          usage: ZERO_USAGE,
          raw: undefined,
        };
      },
    });

    const client = new Antra({ provider });
    const agentA = Agent.builder()
      .client(client)
      .model("mock")
      .name("agent-a")
      .instructions("A")
      .maxHandoffDepth(3)
      .build();
    const agentB = Agent.builder()
      .client(client)
      .model("mock")
      .name("agent-b")
      .instructions("B")
      .maxHandoffDepth(3)
      .build();
    agentA.addHandoff(agentB);
    agentB.addHandoff(agentA);

    await expect(agentA.run("Start the cycle.")).rejects.toThrow(HandoffError);
  });

  it("agent.getTrace(runId) returns the same shared trace from any agent in the chain", async () => {
    let call = 0;
    const provider = new MockProvider({
      respond: () => {
        call++;
        if (call === 1)
          return {
            content: "",
            toolCalls: [{ id: "call_1", name: "handoff_to_specialist", args: { reason: "x" } }],
            finishReason: "tool_calls",
            usage: ZERO_USAGE,
            raw: undefined,
          };
        return {
          content: "done",
          toolCalls: [],
          finishReason: "stop",
          usage: ZERO_USAGE,
          raw: undefined,
        };
      },
    });
    const client = new Antra({ provider });
    const specialist = Agent.builder()
      .client(client)
      .model("mock")
      .name("specialist")
      .instructions("S")
      .build();
    const router = Agent.builder()
      .client(client)
      .model("mock")
      .name("router")
      .instructions("R")
      .handoffs([specialist])
      .build();

    const result = await router.run("Handle this.");

    const traceFromRouter = router.getTrace(result.runId);
    const traceFromSpecialist = specialist.getTrace(result.runId);
    expect(traceFromRouter).toBeDefined();
    expect(traceFromRouter).toBe(traceFromSpecialist);
    expect(traceFromRouter?.agentNames).toEqual(expect.arrayContaining(["router", "specialist"]));
  });
});
