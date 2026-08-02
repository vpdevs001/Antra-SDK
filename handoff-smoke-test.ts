/**
 * Smoke test for Chapter 9 — handoffs.
 * Covers: a router agent delegating to a specialist (context preserved,
 * correct agent identified, events + handoffChain populated), and a
 * deliberately cyclic handoff configuration being caught by
 * maxHandoffDepth rather than hanging.
 */
import { Antra, Agent, HandoffError } from "./src/index.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function mockGenerateSequence(responders: Array<(body: any) => object>) {
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const responder = responders[callCount] ?? responders[responders.length - 1];
    callCount++;
    return new Response(JSON.stringify(responder!(body)), { status: 200 });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    getCallCount: () => callCount,
  };
}

const client = new Antra({ apiKey: "test-key" });

// --- 1. Router hands off to a specialist; context + identity preserved ---
async function testSuccessfulHandoff() {
  const { restore, getCallCount } = mockGenerateSequence([
    (body) => {
      const handoffTool = body.tools?.find(
        (t: any) => t.function.name === "handoff_to_billing-specialist"
      );
      assert(handoffTool !== undefined, "handoff tool not exposed to the router agent");
      return {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "handoff_to_billing-specialist",
                    arguments: '{"reason":"User has a billing question about a refund."}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
    },
    (body) => {
      const originalUserMsg = body.messages.find(
        (m: any) => m.content === "I want a refund for my last order."
      );
      assert(
        originalUserMsg !== undefined,
        "original user message was not preserved in the handoff context"
      );
      const handoffNote = body.messages.find(
        (m: any) => typeof m.content === "string" && m.content.includes("Handoff from")
      );
      assert(handoffNote !== undefined, "handoff note not present for the specialist");
      return {
        choices: [
          {
            message: { content: "I've processed your refund.", tool_calls: undefined },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
      };
    },
  ]);

  const specialist = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .name("billing-specialist")
    .instructions("You handle billing and refund questions.")
    .build();

  const events: string[] = [];
  const router = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .name("router")
    .instructions("Route billing questions to the billing specialist.")
    .handoffs([specialist])
    .onEvent((e) => events.push(e.type))
    .build();

  const result = await router.run("I want a refund for my last order.");

  assert(
    result.content === "I've processed your refund.",
    `unexpected final content: "${result.content}"`
  );
  assert(result.finishReason === "stop", `expected stop, got ${result.finishReason}`);
  assert(
    JSON.stringify(result.handoffChain) === JSON.stringify(["router", "billing-specialist"]),
    `unexpected handoffChain: ${JSON.stringify(result.handoffChain)}`
  );
  assert(events.includes("handoff_started"), "missing handoff_started event");
  assert(events.includes("handoff_completed"), "missing handoff_completed event");
  assert(
    getCallCount() === 2,
    `expected 2 model calls (router + specialist), got ${getCallCount()}`
  );
  console.log(
    "✅ Handoff — router delegates to specialist, context preserved, handoffChain + events correct"
  );

  restore();
}

// --- 2. Cyclic handoff config is caught by maxHandoffDepth, not an infinite loop ---
async function testCyclicHandoffCaught() {
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    // Ping-pong: even calls are "from A" (hands off to B), odd calls are "from B" (hands off to A).
    const target = callCount % 2 === 0 ? "agent-b" : "agent-a";
    callCount++;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: `call_${callCount}`,
                  type: "function",
                  function: {
                    name: `handoff_to_${target}`,
                    arguments: '{"reason":"passing along"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const agentA = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .name("agent-a")
    .instructions("Test agent A.")
    .maxHandoffDepth(3)
    .build();
  const agentB = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .name("agent-b")
    .instructions("Test agent B.")
    .maxHandoffDepth(3)
    .build();
  // Genuine cycle: each hands off to the other, wired post-construction since neither exists before the other.
  agentA.addHandoff(agentB);
  agentB.addHandoff(agentA);

  try {
    await agentA.run("Start the cycle.");
    console.error("❌ expected HandoffError to be thrown — cyclic handoff should not resolve");
  } catch (err) {
    assert(
      err instanceof HandoffError,
      `expected HandoffError, got ${(err as Error).constructor.name}`
    );
    assert(
      callCount <= 4,
      `expected the cycle to be caught within a few hops, but made ${callCount} model calls`
    );
    console.log(
      `✅ Cyclic handoff — caught by maxHandoffDepth (3) after ${callCount} hops instead of looping forever: "${(err as Error).message}"`
    );
  }

  globalThis.fetch = originalFetch;
}

await testSuccessfulHandoff();
await testCyclicHandoffCaught();
console.log("\nAll handoff smoke tests passed.");
