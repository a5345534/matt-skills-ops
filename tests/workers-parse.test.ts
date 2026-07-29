import { describe, expect, it } from "vitest";
import { __workersTestables } from "../src/adapters/workers.js";

// Re-test parsing behavior via a minimal reimplementation of the public contract:
// message_end with embedded stage-result JSON should be recoverable.
// We import the workers module's side-effect-free path by spawning parse through
// a thin dynamic evaluation of stdout handling is hard; instead test the
// embedded extraction logic by constructing the same line format workers emit
// as progress vs stage-result top-level.

// The workers module does not export parse helpers; validate the protocol
// strings the prompt requires remain parseable as top-level JSON.

describe("worker stage-result protocol JSON", () => {
  it("maps Pi turn_start to worker turn telemetry", () => {
    const event = __workersTestables.parseWorkerProtocolEvent(
      "implement-42-19-r1",
      JSON.stringify({
        type: "turn_start",
        turnIndex: 3,
        timestamp: 1_700_000_000_000,
      }),
    );
    expect(event).toEqual({
      type: "turn-start",
      workerId: "implement-42-19-r1",
      timestampMs: 1_700_000_000_000,
    });
  });

  it("maps assistant stopReason=error to worker-error", () => {
    const event = __workersTestables.parseWorkerProtocolEvent(
      "implement-38-44-r2",
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage:
            'OpenAI API error (403): 403 "Your newly created team doesn\'t have any credits"',
        },
      }),
    );
    expect(event).toEqual({
      type: "worker-error",
      workerId: "implement-38-44-r2",
      message:
        'OpenAI API error (403): 403 "Your newly created team doesn\'t have any credits"',
    });
  });

  it("parses completed stage-result as top-level JSON", () => {
    const line = JSON.stringify({
      type: "stage-result",
      outcome: {
        status: "completed",
        summary: "landed ADR",
        localCommitSha: "abc123",
      },
    });
    const parsed = JSON.parse(line) as {
      type: string;
      outcome: { status: string; summary?: string };
    };
    expect(parsed.type).toBe("stage-result");
    expect(parsed.outcome.status).toBe("completed");
  });

  it("finds stage-result inside a fenced assistant message", () => {
    const text = [
      "## Done — #256",
      "",
      "```json",
      '{',
      '  "type": "stage-result",',
      '  "outcome": {',
      '    "status": "completed",',
      '    "summary": "docs landed"',
      "  }",
      "}",
      "```",
    ].join("\n");

    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    expect(fence?.[1]).toBeTruthy();
    const obj = JSON.parse(fence![1]!.trim()) as {
      type: string;
      outcome: { status: string };
    };
    expect(obj.type).toBe("stage-result");
    expect(obj.outcome.status).toBe("completed");
  });
});
