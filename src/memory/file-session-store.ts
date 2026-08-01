import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "../core/types.js";
import type { SessionStore } from "./session-store.js";
import { InvalidRequestError } from "../errors/index.js";

/** Only safe filename characters — anything else in a sessionId is rejected outright rather than silently sanitized, to avoid surprising path collisions. */
const SAFE_SESSION_ID = /^[a-zA-Z0-9._-]+$/;

export interface FileSessionStoreConfig {
  /** Directory to store session files in. Created automatically if it doesn't exist. */
  dir: string;
}

/**
 * Persists each session as its own `<sessionId>.json` file under `dir`.
 * Survives process restarts, unlike InMemorySessionStore — the natural
 * next step up once you need that.
 */
export class FileSessionStore implements SessionStore {
  private readonly dir: string;

  constructor(config: FileSessionStoreConfig) {
    this.dir = config.dir;
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const filePath = this.filePathFor(sessionId);
    try {
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as Message[];
    } catch (err) {
      if (isNotFoundError(err)) return [];
      throw new InvalidRequestError(
        `FileSessionStore: failed to read session "${sessionId}": ${describeError(err)}`,
        {
          cause: err,
        }
      );
    }
  }

  async setMessages(sessionId: string, messages: Message[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const filePath = this.filePathFor(sessionId);
    await writeFile(filePath, JSON.stringify(messages, null, 2), "utf-8");
  }

  async clear(sessionId: string): Promise<void> {
    const filePath = this.filePathFor(sessionId);
    try {
      await rm(filePath);
    } catch (err) {
      if (isNotFoundError(err)) return; // already gone — clearing a nonexistent session is not an error
      throw new InvalidRequestError(
        `FileSessionStore: failed to clear session "${sessionId}": ${describeError(err)}`,
        {
          cause: err,
        }
      );
    }
  }

  private filePathFor(sessionId: string): string {
    if (!SAFE_SESSION_ID.test(sessionId)) {
      throw new InvalidRequestError(
        `FileSessionStore: sessionId "${sessionId}" contains characters outside [a-zA-Z0-9._-] — rejected rather than sanitized, to avoid silent filename collisions.`
      );
    }
    return join(this.dir, `${sessionId}.json`);
  }
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
