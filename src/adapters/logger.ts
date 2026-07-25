import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type MattAutoLogger = {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  /** Absolute path of today's log file (best-effort). */
  filePath(): string;
};

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function serializeData(data: unknown): string {
  if (data === undefined) return "";
  try {
    const json = JSON.stringify(data, (_key, value) => {
      if (typeof value === "string" && value.length > 500) {
        return `${value.slice(0, 500)}…`;
      }
      return value;
    });
    return json ? ` ${json}` : "";
  } catch {
    return ` ${String(data)}`;
  }
}

/**
 * Append-only local debug log for Matt Auto.
 * Lives under the Workflow root's `.pi/matt-auto/logs/` (rebuildable cache).
 * Never published to GitHub.
 */
export function createMattAutoLogger(workflowRoot: string): MattAutoLogger {
  const dir = path.join(workflowRoot, ".pi", "matt-auto", "logs");
  const file = path.join(dir, `matt-auto-${dayStamp()}.log`);
  let ready: Promise<void> | undefined;
  const queue: string[] = [];
  let flushing = false;

  async function ensureDir(): Promise<void> {
    if (!ready) {
      ready = mkdir(dir, { recursive: true }).then(() => undefined);
    }
    await ready;
  }

  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      await ensureDir();
      while (queue.length > 0) {
        const chunk = queue.splice(0, queue.length).join("");
        await appendFile(file, chunk, "utf8");
      }
    } catch {
      // Logging must never break the product path.
    } finally {
      flushing = false;
      if (queue.length > 0) void flush();
    }
  }

  function write(level: LogLevel, message: string, data?: unknown): void {
    const line = `${new Date().toISOString()} [${level}] ${message}${serializeData(data)}\n`;
    queue.push(line);
    void flush();
    // Also mirror warnings/errors to stderr for live sessions.
    if (level === "warn" || level === "error") {
      console.error(`[matt-auto] ${message}`);
    }
  }

  return {
    debug: (message, data) => write("debug", message, data),
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
    filePath: () => file,
  };
}

/** Global session logger fallback before a Workflow root is bound. */
export function createSessionLogger(): MattAutoLogger {
  return createMattAutoLogger(
    path.join(os.homedir(), ".pi", "agent", "matt-auto", "session"),
  );
}
