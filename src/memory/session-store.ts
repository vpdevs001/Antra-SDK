import type { Message } from "../core/types.js";

/**
 * Persists conversation history across separate `agent.run()` calls,
 * addressed by a `sessionId`. Mirrors the `Provider` pattern from
 * Chapter 1: one small interface, swappable implementations — adding
 * SQLite/Redis/a custom store later is a matter of implementing this,
 * not forking the SDK.
 *
 * Deliberately whole-transcript, not incremental: the agent always
 * writes the full updated message array back after a run, rather than
 * appending piecemeal. Simpler semantics, and avoids partial-write
 * corruption if a store implementation isn't atomic.
 */
export interface SessionStore {
  /** Retrieves the message history for a session. Returns `[]` if the session doesn't exist yet — never throws for a missing session. */
  getMessages(sessionId: string): Promise<Message[]>;
  /** Overwrites the stored messages for a session with the full, current transcript. */
  setMessages(sessionId: string, messages: Message[]): Promise<void>;
  /** Deletes a session entirely. */
  clear(sessionId: string): Promise<void>;
}

/**
 * Zero-setup default — an Agent gets one of these automatically if no
 * store is configured via `AgentBuilder.sessionStore(...)`. Fine for
 * a single process's lifetime; state is lost on restart, which is
 * exactly when you'd reach for FileSessionStore or a custom adapter
 * instead.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Message[]>();

  async getMessages(sessionId: string): Promise<Message[]> {
    return this.sessions.get(sessionId) ?? [];
  }

  async setMessages(sessionId: string, messages: Message[]): Promise<void> {
    this.sessions.set(sessionId, messages);
  }

  async clear(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
