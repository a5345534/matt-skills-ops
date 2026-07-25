import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { TranscriptKey, TranscriptPort } from "../ports.js";

function transcriptRoot(workflowRoot: string): string {
  return path.join(path.resolve(workflowRoot), ".pi", "matt-auto", "transcripts");
}

/** Absolute path of one attempt's jsonl transcript (inspection handle). */
export function workerTranscriptPath(
  workflowRoot: string,
  key: TranscriptKey,
): string {
  return path.join(
    transcriptRoot(workflowRoot),
    String(key.workflowId),
    `ticket-${key.ticketNumber}`,
    `r${key.attempt}.jsonl`,
  );
}

function transcriptPath(workflowRoot: string, key: TranscriptKey): string {
  return workerTranscriptPath(workflowRoot, key);
}

/**
 * Local, uncommitted Worker transcript storage under `.pi/matt-auto/transcripts/`.
 * Never published to GitHub.
 */
export function createTranscriptPort(workflowRoot: string): TranscriptPort {
  return {
    async append(key, event) {
      const filePath = transcriptPath(workflowRoot, key);
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
    },

    async read(key) {
      const filePath = transcriptPath(workflowRoot, key);
      try {
        const raw = await readFile(filePath, "utf8");
        const events: unknown[] = [];
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            events.push(JSON.parse(trimmed));
          } catch {
            events.push({ type: "unparseable", raw: trimmed });
          }
        }
        return events;
      } catch {
        return [];
      }
    },

    async cleanupWorkflowTranscripts(workflowId) {
      const dir = path.join(transcriptRoot(workflowRoot), String(workflowId));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
