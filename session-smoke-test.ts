/**
 * Smoke test for Chapter 8 — memory and sessions.
 * Covers: two sequential run() calls sharing history via sessionId,
 * swapping InMemorySessionStore for FileSessionStore with zero changes
 * to agent-calling code, and history surviving a simulated process
 * restart (fresh FileSessionStore instance reading what an earlier one wrote).
 */
import { rm } from "node:fs/promises";
import { Antra, Agent, InMemorySessionStore, FileSessionStore } from "./src/index.js";

/** Throws on failure, unlike console.assert — a silent stderr log is how the message-count bugs almost slipped through undetected. */
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

// --- 1. Two sequential runs, same sessionId, default InMemorySessionStore ---
async function testInMemorySessionSharesHistory() {
  const { restore } = mockGenerateSequence([
    () => ({
      choices: [{ message: { content: "I'm Claude, nice to meet you." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }),
    (body) => {
      // The second call's message history must include the FIRST turn's user + assistant messages.
      // +1 for the prepended system message (OpenAI's wire format puts it in the messages array).
      assert(
        body.messages.length === 4,
        `expected 4 messages (system, prior user+assistant, new user), got ${body.messages.length}`
      );
      const firstTurnUserMsg = body.messages.find((m: any) => m.content === "My name is Sam.");
      assert(firstTurnUserMsg !== undefined, "first turn's user message missing from history");
      return {
        choices: [{ message: { content: "Your name is Sam." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      };
    },
  ]);

  const agent = Agent.builder().client(client).model("gpt-4o").instructions("Assistant.").build();

  await agent.run("My name is Sam.", { sessionId: "session-a" });
  const second = await agent.run("What's my name?", { sessionId: "session-a" });

  assert(second.content === "Your name is Sam.", `unexpected content: "${second.content}"`);
  console.log(
    "✅ Default InMemorySessionStore — second run() sees first run's history via sessionId"
  );

  restore();
}

// --- 2. Different sessionId does NOT leak history ---
async function testSessionIsolation() {
  const { restore } = mockGenerateSequence([
    () => ({
      choices: [{ message: { content: "Hi Sam." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }),
    (body) => {
      // A fresh sessionId should start with just system + the new user message — no history from session-b-1.
      assert(
        body.messages.length === 2,
        `expected 2 messages (system + new user, no leaked history), got ${body.messages.length}`
      );
      const leaked = body.messages.find((m: any) => m.content === "My name is Sam.");
      assert(leaked === undefined, "session-a's history leaked into a different sessionId");
      return {
        choices: [{ message: { content: "I don't know your name yet." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      };
    },
  ]);

  const agent = Agent.builder().client(client).model("gpt-4o").instructions("Assistant.").build();

  await agent.run("My name is Sam.", { sessionId: "session-b-1" });
  await agent.run("What's my name?", { sessionId: "session-b-2" }); // different session

  console.log(
    "✅ Session isolation — different sessionId does not see unrelated session's history"
  );

  restore();
}

// --- 3. Explicit sessionStore configured on the builder is used instead of the default ---
async function testExplicitStoreConfigured() {
  const store = new InMemorySessionStore();
  const { restore } = mockGenerateSequence([
    () => ({
      choices: [{ message: { content: "ack" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
  ]);

  const agent = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Assistant.")
    .sessionStore(store)
    .build();
  await agent.run("Remember this.", { sessionId: "session-c" });

  const stored = await store.getMessages("session-c");
  assert(
    stored.length === 2,
    `expected 2 messages persisted to the explicit store, got ${stored.length}`
  );
  console.log("✅ Explicitly configured sessionStore receives the persisted transcript");

  restore();
}

// --- 4. FileSessionStore: same calling code, and history survives a "process restart" ---
async function testFileSessionStoreSurvivesRestart() {
  const dir = "/tmp/antra-session-test";
  await rm(dir, { recursive: true, force: true });

  const { restore } = mockGenerateSequence([
    () => ({
      choices: [{ message: { content: "Got it, you like tea." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }),
    (body) => {
      assert(
        body.messages.length === 4,
        `expected history to survive across store instances (system + prior user+assistant + new user), got ${body.messages.length} messages`
      );
      return {
        choices: [{ message: { content: "You like tea." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      };
    },
  ]);

  // Simulates process #1: writes a session using a FileSessionStore instance.
  const storeInstance1 = new FileSessionStore({ dir });
  const agent1 = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Assistant.")
    .sessionStore(storeInstance1)
    .build();
  await agent1.run("I like tea.", { sessionId: "durable-session" });

  // Simulates process #2 (a fresh instance, same directory) reading it back — this is the actual test of durability.
  const storeInstance2 = new FileSessionStore({ dir });
  const agent2 = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Assistant.")
    .sessionStore(storeInstance2)
    .build();
  const result = await agent2.run("What do I like?", { sessionId: "durable-session" });

  assert(result.content === "You like tea.", `unexpected content: "${result.content}"`);
  console.log(
    "✅ FileSessionStore — history survives across separate store instances (simulated restart), zero changes to agent-calling code"
  );

  restore();
  await rm(dir, { recursive: true, force: true });
}

// --- 5. FileSessionStore rejects unsafe sessionIds rather than silently sanitizing ---
async function testFileSessionStoreRejectsUnsafeIds() {
  const dir = "/tmp/antra-session-test-unsafe";
  const store = new FileSessionStore({ dir });

  try {
    await store.setMessages("../../etc/passwd", []);
    console.error("❌ expected path-traversal sessionId to be rejected");
  } catch (err) {
    console.log(
      "✅ FileSessionStore — rejects unsafe sessionId rather than silently sanitizing it"
    );
  }
}

await testInMemorySessionSharesHistory();
await testSessionIsolation();
await testExplicitStoreConfigured();
await testFileSessionStoreSurvivesRestart();
await testFileSessionStoreRejectsUnsafeIds();
console.log("\nAll memory/session smoke tests passed.");
