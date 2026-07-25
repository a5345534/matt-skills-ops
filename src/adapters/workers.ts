import { type ChildProcess, spawn } from "node:child_process";
import type {
  WorkerLaunchInput,
  WorkerRuntimeInfo,
  WorkersPort,
} from "../ports.js";
import type { WorkerProtocolEvent } from "../types.js";

type Running = {
  child: ChildProcess;
  sink: { onEvent(event: WorkerProtocolEvent): void | Promise<void> };
  buffer: string;
  sawStageResult: boolean;
};

function isChildAlive(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runtimeOf(workerId: string, entry: Running): WorkerRuntimeInfo {
  return {
    workerId,
    ...(typeof entry.child.pid === "number" ? { pid: entry.child.pid } : {}),
    alive: isChildAlive(entry.child),
  };
}

function parseStageResultFromLine(
  workerId: string,
  line: string,
): WorkerProtocolEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;

  // Matt Auto Worker protocol Stage result (structured custom event).
  if (obj.type === "matt-auto.stage-result" || obj.type === "stage-result") {
    const outcome = obj.outcome as Record<string, unknown> | undefined;
    if (outcome?.status === "completed") {
      const result: WorkerProtocolEvent = {
        type: "stage-result",
        workerId,
        outcome: { status: "completed" },
      };
      if (typeof outcome.summary === "string") {
        result.outcome = {
          status: "completed",
          summary: outcome.summary,
          ...(typeof outcome.localCommitSha === "string"
            ? { localCommitSha: outcome.localCommitSha }
            : {}),
        };
      } else if (typeof outcome.localCommitSha === "string") {
        result.outcome = {
          status: "completed",
          localCommitSha: outcome.localCommitSha,
        };
      }
      return result;
    }
    if (outcome?.status === "failed") {
      return {
        type: "stage-result",
        workerId,
        outcome: {
          status: "failed",
          reason:
            typeof outcome.reason === "string"
              ? outcome.reason
              : "Implementation worker reported failure without a reason.",
        },
      };
    }
  }

  // Progress / embedded Stage result from message_end assistant text.
  if (obj.type === "message_end") {
    const message = obj.message as Record<string, unknown> | undefined;
    if (message?.role === "assistant") {
      const content = message.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .map((part) => {
            if (part && typeof part === "object" && "text" in part) {
              return String((part as { text: unknown }).text ?? "");
            }
            return "";
          })
          .join("");
      }
      const trimmed = text.trim();
      if (!trimmed) return undefined;

      // Agents often print Stage result JSON inside assistant text (not as a
      // top-level protocol line). Accept that form.
      const embedded = extractEmbeddedStageResult(workerId, trimmed);
      if (embedded) return embedded;

      const firstLine = trimmed.split("\n")[0] ?? trimmed;
      return {
        type: "progress",
        workerId,
        message:
          firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine,
      };
    }
  }

  return undefined;
}

/** Try to recover a Stage result JSON object from free-form assistant text. */
function extractEmbeddedStageResult(
  workerId: string,
  text: string,
): WorkerProtocolEvent | undefined {
  // Prefer fenced json blocks, then any {...} containing stage-result.
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m[1]) candidates.push(m[1].trim());
  }
  candidates.push(text);

  for (const candidate of candidates) {
    if (!/stage-result/i.test(candidate)) continue;
    // Scan for JSON objects; try progressively larger slices from each '{'.
    for (let i = 0; i < candidate.length; i += 1) {
      if (candidate[i] !== "{") continue;
      for (let j = candidate.length; j > i + 8; j -= 1) {
        if (candidate[j - 1] !== "}") continue;
        const slice = candidate.slice(i, j);
        if (!/stage-result/i.test(slice)) continue;
        try {
          const parsed = JSON.parse(slice) as Record<string, unknown>;
          const synthetic = parseStageResultFromLine(
            workerId,
            JSON.stringify(parsed),
          );
          if (synthetic?.type === "stage-result") return synthetic;
        } catch {
          // keep scanning
        }
      }
    }
  }
  return undefined;
}

/**
 * Session-owned workers as Pi JSON event stream processes.
 * Implementation workers run in an Implementation workspace; Conflict resolution
 * workers run in the Integration workspace. Neither receives remote-write authority.
 */
export function createWorkersPort(): WorkersPort {
  const running = new Map<string, Running>();

  async function deliver(
    entry: Running,
    event: WorkerProtocolEvent,
  ): Promise<void> {
    if (event.type === "stage-result") {
      entry.sawStageResult = true;
    }
    await entry.sink.onEvent(event);
  }

  function attachStdout(workerId: string, entry: Running): void {
    entry.child.stdout?.on("data", (chunk: Buffer | string) => {
      entry.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let newline = entry.buffer.indexOf("\n");
      while (newline !== -1) {
        let line = entry.buffer.slice(0, newline);
        entry.buffer = entry.buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const event = parseStageResultFromLine(workerId, line);
        if (event) {
          void deliver(entry, event);
        }
        newline = entry.buffer.indexOf("\n");
      }
    });
  }

  return {
    async launch(input: WorkerLaunchInput, sink) {
      if (running.has(input.workerId)) {
        throw new Error(`Worker \"${input.workerId}\" is already running.`);
      }

      // Pi JSON event stream in the Implementation workspace.
      // --no-session keeps worker transcripts under Matt Auto run storage only.
      const args = [
        "--mode",
        "json",
        "--no-session",
        "--provider",
        input.workerProfile.provider,
        "--model",
        `${input.workerProfile.provider}/${input.workerProfile.modelId}:${input.workerProfile.thinkingLevel}`,
        input.prompt,
      ];

      const child = spawn("pi", args, {
        cwd: input.worktreePath,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const entry: Running = {
        child,
        sink,
        buffer: "",
        sawStageResult: false,
      };
      running.set(input.workerId, entry);
      attachStdout(input.workerId, entry);

      child.on("error", (error) => {
        void deliver(entry, {
          type: "stage-result",
          workerId: input.workerId,
          outcome: {
            status: "failed",
            reason: `Implementation worker process failed to start: ${error.message}`,
          },
        }).finally(() => {
          running.delete(input.workerId);
        });
      });

      child.on("close", (code) => {
        void (async () => {
          try {
            await deliver(entry, {
              type: "process-exit",
              workerId: input.workerId,
              code,
            });
          } finally {
            running.delete(input.workerId);
          }
        })();
      });

      return runtimeOf(input.workerId, entry);
    },

    getRuntime(workerId: string) {
      const entry = running.get(workerId);
      if (!entry) return undefined;
      return runtimeOf(workerId, entry);
    },

    async abort(workerId: string) {
      const entry = running.get(workerId);
      if (!entry) return;
      entry.child.kill("SIGTERM");
      // Force-kill if the process ignores SIGTERM.
      const force = setTimeout(() => {
        if (!entry.child.killed) {
          entry.child.kill("SIGKILL");
        }
      }, 2000);
      force.unref?.();
    },

    async abortAll() {
      for (const entry of running.values()) {
        entry.child.kill("SIGTERM");
        const force = setTimeout(() => {
          if (!entry.child.killed) {
            entry.child.kill("SIGKILL");
          }
        }, 2000);
        force.unref?.();
      }
    },
  };
}
