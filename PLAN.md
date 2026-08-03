# Antra SDK — Build Plan (v2)

Updated to align with the full assignment spec: an open-source AI Agent
SDK with its own agent runtime, tools, handoffs, guardrails, memory,
structured output, streaming, tracing, and multi-provider support — all
built from scratch, not on top of another agent framework.

Chapters 1–4 are already built and verified. Chapters 5+ are
restructured from the original plan to map directly onto the assignment's
ten numbered requirements (see the traceability table at the end).

---

## Chapter 0 — Goals (not features)

Unchanged from v1 — still the standard every chapter is held to:

1. **Type safety is not opt-in.**
2. **Fail loudly, fail specifically.**
3. **No magic.**
4. **Predictable across providers, honest about differences.**
5. **Minimal dependencies as a discipline, not a slogan.**
6. **Boilerplate is a bug.**
7. **Docs are part of the product, not an afterthought.**
8. **Agent-ready by default.**
9. **Test without spending money.**

One addition, specific to this phase of the assignment:

10. **Every capability must actually work, not just exist.** The brief
    is explicit that marks depend on capabilities functioning correctly,
    not on how many configuration fields are present. Nothing ships in
    this plan without a smoke test proving the real, wired-up behavior —
    the same standard Chapters 1–4 were already held to.

---

## Chapter 1 — Foundations ✅ _Complete_

Core types, typed error hierarchy, the `Provider` interface, `defineTool()`
with zod → JSON Schema conversion. Strict-mode typecheck passing.

---

## Chapter 2 — Core Generation ✅ _Complete_

`Antra` client + `OpenAIProvider`: non-streaming `generate()`, streaming
`stream()`, OpenAI error mapping onto the typed error hierarchy, timeout

- cancellation via `AbortController`. Smoke-tested against mocked `fetch`.

---

## Chapter 3 — Tool Calling ✅ _Complete_

`defineTool()`, JSON Schema generation, tool-call parsing in both
streaming and non-streaming responses, native tool-calling wire format
(no hand-parsed JSON — this was the key decision after reviewing the
POC).

---

## Chapter 4 — Agent Runtime ✅ _Complete_

_(Assignment requirement #1: Agent Runtime)_

`Agent` / `AgentBuilder`: accepts user input, sends instructions + tools
to the model, detects tool calls via the native path, executes them with
zod-validated args, feeds results back, loops until a final answer or
`maxSteps`. `AgentEvent` observability hooks. Smoke-tested end-to-end
with a mocked two-round-trip tool call.

**Still open from this requirement, folded into later chapters:**

- "Stops when limits are reached" — `maxSteps` exists; token/time-based
  limits belong in Chapter 11 (Tracing & Reliability), since they need
  usage data the runtime already collects but doesn't yet enforce against.
- "Handle failures safely" — tool-level failures are handled (Ch. 4),
  but _agent-level_ failure handling (guardrail rejections, structured
  output validation failures) is Chapter 6/7.

---

## Chapter 5 — Model Provider Abstraction & Fallback ✅ _Complete_

_(Assignment requirement #10: Model Providers)_

Pulled forward from the original plan's Chapter 7 — the assignment
requires this explicitly and early, so it shouldn't wait behind features
that don't need it.

- Add a real second provider (Anthropic) implementing the same
  `Provider` interface from Chapter 1 — this is the real test of whether
  the abstraction holds up, not just the OpenAI-shaped assumption baked
  into it so far
- Capability flags (`supportsParallelToolCalls`, `supportsVision`, etc.)
  so callers can check what a provider/model actually supports instead
  of finding out via a runtime error
- Model fallback chains — `new Antra({ providers: [primary, fallback] })`
  or equivalent; on a `ProviderError`/`RateLimitError` from the primary,
  retry against the fallback before surfacing the failure
- Per-provider error mapping stays isolated (as it already is for
  OpenAI) — Anthropic's error shapes get their own mapping file, nothing
  shared assumes OpenAI's wire format

**Exit criteria:** the same `Agent` from Chapter 4 runs unmodified
against either provider, and a fallback chain survives a simulated
primary-provider failure in a smoke test.

---

## Chapter 6 — Guardrails ✅ _Complete_

_(Assignment requirement #6: Guardrails)_

New chapter — not in the original plan. This is where "handle failures
safely" partly lives, alongside dedicated input/output/tool validation.

- **Input guardrails** — validate/reject user input before it reaches
  the model (e.g. length limits, blocked patterns)
- **Output guardrails** — validate the model's final response before
  it's returned to the caller (e.g. structured output validation,
  sensitive-data redaction)
- **Tool guardrails** — intercept a requested tool call _before_
  execution; can reject it outright or require explicit approval
  (formalizes the "human-in-the-loop" idea noted but deferred in
  Chapter 4)
- Guardrails are plain functions with a typed signature
  (`(input) => GuardrailResult`), registered on `AgentBuilder`, not a
  new subclassing mechanism — keeps with "boilerplate is a bug"
- A triggered guardrail produces a typed result (not a thrown exception
  by default) so the agent can react programmatically, but a
  `strict: true` mode can promote violations to thrown `AntraError`s for
  callers who want hard failures

**Exit criteria:** a smoke test where an input guardrail rejects a
malicious prompt, a tool guardrail blocks a dangerous call before
execution, and an output guardrail catches a bad final response — all
three produce clear, typed results and show up as `guardrail_triggered`
events (Chapter 10).

---

## Chapter 7 — Structured Output ✅ _Complete_

_(Assignment requirement #7: Structured Output)_

- `agent.run(query, { outputSchema: zodSchema })` — reuses the same
  zod → JSON Schema machinery already built for tools (Chapter 1's
  `zodToJsonSchema`), so there's no second schema system to maintain
- Validates the model's final output against the schema; on failure,
  returns a typed validation error with the specific field-level
  problems (via zod's own error format), not a generic "invalid output"
- **Retry/repair loop** — on validation failure, optionally re-prompt
  the model with the validation errors included, up to a configurable
  number of attempts, before giving up
- TypeScript types are inferred end-to-end: `agent.run()`'s return type
  reflects the schema passed in, the same way `defineTool()`'s
  `execute()` already infers argument types from its schema

**Exit criteria:** a smoke test where a schema-defined agent call
initially gets malformed output from the (mocked) model, self-repairs
via the retry loop, and returns a correctly-typed, validated result.

---

## Chapter 8 — Memory & Sessions ✅ _Complete_

_(Assignment requirement #4: Memory and Sessions)_

The brief explicitly requires separating three concerns that are easy to
conflate — this chapter exists to keep them cleanly apart:

- **Agent configuration** — static, set once via `AgentBuilder`
  (instructions, tools, model, guardrails). Doesn't change between runs.
- **Run state** — everything scoped to a single `agent.run()` call
  (the message transcript, current step count, in-progress tool calls).
  Already exists informally in `AgentResult`; this chapter makes it a
  first-class, inspectable object.
- **Persistent session state** — conversation history that outlives a
  single `run()` call, addressed by a `sessionId`, so a multi-turn
  conversation can be resumed later.
- `SessionStore` interface (mirrors the `Provider` pattern from
  Chapter 1: one interface, swappable implementations):
  - `InMemorySessionStore` (default, zero setup)
  - `FileSessionStore` (JSON on disk)
  - A documented adapter contract so SQLite/Redis/custom stores are a
    matter of implementing the interface, not forking the SDK

**Exit criteria:** two sequential `agent.run()` calls with the same
`sessionId` share conversation history correctly, and swapping
`InMemorySessionStore` for `FileSessionStore` requires no changes to
agent-calling code.

---

## Chapter 9 — Handoffs ✅ _Complete_

_(Assignment requirement #5: Handoffs)_

Multi-agent delegation — one agent hands a task to another.

- `handoffTo(agentName)` — exposed to the model as a special tool-like
  action (reuses the native tool-calling path from Chapter 3, not a new
  mechanism)
- Preserves required context — the conversation history (and relevant
  session state from Chapter 8) transfers to the receiving agent rather
  than starting cold
- The receiving agent is identified explicitly (by name, resolved
  against a registry the caller provides — no implicit global agent
  lookup, keeping with "no magic")
- **Loop prevention** — a visited-agents set (or max-handoff-depth
  counter) per run; exceeding it raises a typed error rather than
  recursing forever
- Handoffs emit `handoff_started` / `handoff_completed` events
  (Chapter 10) and appear in the run's trace (Chapter 11)

**Exit criteria:** a smoke test with two agents (e.g. a router agent and
a specialist agent) where the router hands off correctly, and a second
smoke test proving a deliberately-cyclic handoff configuration is caught
and rejected rather than hanging.

---

## Chapter 10 — Streaming & Events ✅ _Complete_

_(Assignment requirement #8: Streaming and Events)_

Chapter 2 already built low-level model-response streaming
(`StreamChunk`). Chapter 4 already has `AgentEvent` for observability.
This chapter unifies both into one coherent runtime event stream at the
agent level, not just the raw model-call level.

- Event types: `text_delta`, `tool_started`, `tool_completed`,
  `handoff_started`, `guardrail_triggered`, `run_completed`, `run_failed`
  (superset of Chapter 4's `AgentEvent`, extended for guardrails/handoffs)
- Two consumption styles, since the brief explicitly allows either:
  - Async iterator: `for await (const event of agent.stream(query))`
  - Callback/listener: `agent.onEvent(listener)` (already exists from
    Chapter 4 — this chapter extends its event vocabulary)
- Both are backed by the same internal event source — no duplicated
  logic between the two consumption styles

**Exit criteria:** the same run produces an identical event sequence
whether consumed via `for await` or via `onEvent`, verified in a smoke
test.

---

## Chapter 11 — Tracing & Reliability ✅ _Complete_

_(Assignment requirement #9: Tracing and Reliability, plus the deferred
retries/backoff from the original plan's Chapter 9)_

- `Trace` object per run: `runId`, agent name(s) involved, every model
  call (with timing + token usage), every tool call, every handoff,
  every retry, every error — assembled from the same events Chapter 10
  already emits, not a parallel logging system
- Automatic retries with exponential backoff on transient provider
  errors (`RateLimitError`, `ProviderError` with 5xx), configurable per
  agent/run
- Enforced run-level limits using the usage data already being
  collected — max tokens, max wall-clock time — completing the "stops
  when limits are reached" requirement from Chapter 4
- `trace.toJSON()` / pretty-printer for inspecting a run after the fact

**Exit criteria:** a smoke test run produces a complete, accurate trace
object — including a simulated retry — and a deliberately slow mocked
call is cut off by a wall-clock limit rather than hanging indefinitely.

---

## Chapter 12 — Built-in Tools _(lower priority)_ ✅ _Complete_

Demoted from the original plan's Chapter 5 — the assignment requires
that developers _can_ define custom tools well (already true as of
Chapter 3/4), not that specific built-ins ship. Worth doing for a
polished release, not required for the assignment's core marks.

- Web search tool, command execution tool (sandboxed), file read/write
  tool — each just a `defineTool()` call, proving the public tool API is
  sufficient for real tools, not only toy examples

---

## Chapter 13 — Testing & Mocking

- Mock `Provider` implementation (same interface as OpenAI/Anthropic)
  for deterministic, zero-cost testing
- Deterministic fixtures for streaming, tool calls, handoffs, and
  guardrail triggers
- Formal test suite via `vitest`, replacing the ad-hoc `smoke-test.ts` /
  `agent-smoke-test.ts` scripts used through Chapters 2–11

---

## Chapter 14 — Documentation Site & Open-Source Packaging

_(Assignment's Documentation section, plus original plan's packaging)_

- Hosted docs (e.g. a static site — VitePress/Docusaurus, or a
  well-structured GitHub Pages README site), covering exactly the
  sections the brief lists: Installation, Quick Start, API usage, Tools,
  Handoffs, Guardrails, Memory and Sessions, Structured Output,
  Streaming, Tracing, Error Handling, Examples
- Each section pairs a short explanation with a runnable example — the
  standard set in Chapter 0 ("docs are part of the product")
- `package.json` finalized for real publishing: `exports` map, `files`,
  build via `tsup`, semantic versioning
- `LICENSE` (open-source, per the assignment's requirement), `README.md`
  as the front door, `CONTRIBUTING.md` if accepting outside
  contributions
- A developer should be able to build a working agent using _only_ the
  hosted docs — this chapter isn't done until that's actually true for
  someone who hasn't seen the source

---

## Requirements traceability

| #   | Assignment requirement                              | Chapter(s)               |
| --- | --------------------------------------------------- | ------------------------ |
| 1   | Agent Runtime                                       | 4, 11 (limits)           |
| 2   | Tools (schema, typed result, async, error handling) | 1, 3, 4                  |
| 3   | Agent Capabilities (as many as useful)              | 5–11 collectively        |
| 4   | Memory and Sessions                                 | 8                        |
| 5   | Handoffs                                            | 9                        |
| 6   | Guardrails                                          | 6                        |
| 7   | Structured Output                                   | 7                        |
| 8   | Streaming and Events                                | 2, 10                    |
| 9   | Tracing and Reliability                             | 11                       |
| 10  | Model Providers                                     | 5                        |
| —   | Documentation                                       | 14                       |
| —   | Original name inspired by identity                  | "Antra" — already chosen |

---

## Suggested build order from here

**5 → 6 → 7 → 8 → 9 → 10 → 11**, then 13 and 14 in parallel (tests and
docs can be written as each capability lands rather than saved for the
end — waiting until Chapter 14 to start docs would violate Chapter 0's
"docs are part of the product" goal). Chapter 12 (built-in tools) can
slot in anywhere convenient since nothing else depends on it.

The reasoning for 5 before 6–11: guardrails, structured output, memory,
handoffs, streaming, and tracing all touch the `Agent` run loop directly,
and it's much cheaper to make sure that loop works correctly across two
providers _before_ six more features get layered onto it, than to
discover a provider-abstraction gap after all of them are built on top
of an OpenAI-shaped assumption.
