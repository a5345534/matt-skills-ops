import type { SpecDraft, TicketDraft, TicketsDraft } from "../types.js";

const SPEC_START = "---MATT-AUTO-SPEC-DRAFT---";
const SPEC_END = "---END-MATT-AUTO-SPEC-DRAFT---";
const TICKETS_START = "---MATT-AUTO-TICKETS-DRAFT---";
const TICKETS_END = "---END-MATT-AUTO-TICKETS-DRAFT---";

const PLACEHOLDER_TITLES = new Set([
  "spec title on the first line",
  "title from to-spec synthesis",
]);

/** True when a Create-spec draft is non-empty and not the Matt Auto editor placeholder. */
export function isPublishableSpecDraft(draft: SpecDraft): boolean {
  const title = draft.title.trim();
  const body = draft.body.trim();
  if (!title || !body) return false;
  if (PLACEHOLDER_TITLES.has(title.toLowerCase())) return false;
  if (title.includes(SPEC_START) || title.includes("MATT-AUTO")) return false;

  // Reject bodies that are only empty markdown headings.
  const withoutHeadings = body
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^\s*[-*]\s*$/gm, "")
    .trim();
  if (withoutHeadings.length < 40) return false;
  return true;
}

/**
 * Parse a Create-spec draft from an assistant message.
 * Prefers Matt Auto markers; falls back to first-line title + remaining body.
 * Tolerates leading spaces on markers/fields (common TUI wrap artifacts).
 */
export function parseSpecDraftFromAssistantText(
  text: string,
): SpecDraft | undefined {
  const marked = extractBetween(text, SPEC_START, SPEC_END);
  if (marked) {
    const titleMatch = /^\s*TITLE:\s*(.+)$/m.exec(marked);
    const bodyMatch = /^\s*BODY:\s*\r?\n?([\s\S]*)$/m.exec(marked);
    const title = titleMatch?.[1]?.trim() ?? "";
    const body = (bodyMatch?.[1] ?? "").trim();
    if (title && body) {
      const draft = { title, body };
      return isPublishableSpecDraft(draft) ? draft : undefined;
    }

    // Marker block found but TITLE/BODY lines were nonstandard — treat the
    // whole block as body with a first non-empty line as title.
    const lines = marked
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    if (lines.length >= 2) {
      const fallbackTitle = lines[0]!
        .replace(/^\s*TITLE:\s*/i, "")
        .replace(/^#\s*/, "")
        .trim();
      const fallbackBody = lines
        .slice(1)
        .join("\n")
        .replace(/^\s*BODY:\s*/i, "")
        .trim();
      const draft = { title: fallbackTitle, body: fallbackBody };
      if (isPublishableSpecDraft(draft)) return draft;
    }
  }

  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // Do not use fallback when markers were present but unparsable — avoids
  // treating the start marker as a title.
  if (includesMarker(text, SPEC_START)) return undefined;

  const lines = trimmed.split(/\r?\n/);
  const title = (lines[0] ?? "").replace(/^#\s*/, "").trim();
  const body = lines.slice(1).join("\n").replace(/^\n+/, "").trim();
  if (!title || !body) return undefined;
  const draft = { title, body };
  return isPublishableSpecDraft(draft) ? draft : undefined;
}

/**
 * Parse a Create-tickets draft from an assistant message.
 * Prefers Matt Auto markers wrapping a JSON object.
 */
export function parseTicketsDraftFromAssistantText(
  text: string,
): TicketsDraft | undefined {
  const marked = extractBetween(text, TICKETS_START, TICKETS_END);
  const candidate = (marked ?? text).trim();

  // Strip optional fenced code block (anywhere in the candidate).
  const fenced = /```(?:json)?\s*([\s\S]*?)```/m.exec(candidate);
  const jsonText = (fenced?.[1] ?? candidate).trim();

  try {
    const parsed = JSON.parse(jsonText) as {
      tickets?: Array<{
        localId?: unknown;
        title?: unknown;
        body?: unknown;
        blockedBy?: unknown;
      }>;
    };
    if (!Array.isArray(parsed.tickets) || parsed.tickets.length === 0) {
      return undefined;
    }
    const tickets: TicketDraft[] = [];
    for (const raw of parsed.tickets) {
      const localId = String(raw.localId ?? "").trim();
      const title = String(raw.title ?? "").trim();
      const body = String(raw.body ?? "").trim();
      const blockedBy = Array.isArray(raw.blockedBy)
        ? raw.blockedBy.map((b) => String(b).trim()).filter(Boolean)
        : [];
      if (!localId || !title || !body) continue;
      tickets.push({ localId, title, body, blockedBy });
    }
    return tickets.length > 0 ? { tickets } : undefined;
  } catch {
    return undefined;
  }
}

export function buildCreateSpecSkillPrompt(): string {
  return [
    "/skill:to-spec",
    "",
    "## Matt Auto orchestration (required)",
    "",
    "You are running **inside Matt Auto** after a grilling / design conversation.",
    "The prior conversation is the source of truth — synthesize from it and the codebase.",
    "",
    "### Overrides for this Matt Auto run",
    "1. Do **NOT** create GitHub issues, run `gh`, publish, or label anything.",
    "2. Do **NOT** interview the user or wait for seam confirmation — choose the best seams and record them under Implementation Decisions.",
    "3. Produce a complete PRD-quality body (Problem, Solution, extensive User Stories, Implementation Decisions, Testing Decisions, Out of Scope, Further Notes).",
    "4. When finished, output **exactly** the following block with **no leading spaces** on marker or field lines (no text after the end marker):",
    "",
    SPEC_START,
    "TITLE: <concise spec title>",
    "BODY:",
    "<full markdown body>",
    SPEC_END,
  ].join("\n");
}

export function buildCreateTicketsSkillPrompt(input: {
  workflowId: number;
  title?: string;
}): string {
  const titleLine = input.title
    ? `Parent Workflow / spec: #${input.workflowId} — ${input.title}`
    : `Parent Workflow / spec: #${input.workflowId}`;
  return [
    "/skill:to-tickets",
    "",
    "## Matt Auto orchestration (required)",
    "",
    titleLine,
    "Break this approved/published spec into tracer-bullet tickets.",
    "Read the parent issue and conversation context as needed.",
    "",
    "### Overrides for this Matt Auto run",
    "1. Do **NOT** create GitHub issues, run `gh`, publish, or label anything.",
    "2. Do **NOT** wait for interactive quiz confirmation — produce the best breakdown.",
    "3. Each ticket needs localId, title, body (what to build + acceptance criteria), and blockedBy (localIds or empty).",
    "4. When finished, output **exactly** the following block with **no leading spaces** on marker lines:",
    "",
    TICKETS_START,
    "```json",
    "{",
    '  "tickets": [',
    "    {",
    '      "localId": "1",',
    '      "title": "…",',
    '      "body": "## What to build\\n…\\n\\n## Acceptance criteria\\n- [ ] …",',
    '      "blockedBy": []',
    "    }",
    "  ]",
    "}",
    "```",
    TICKETS_END,
  ].join("\n");
}

/** Find the last assistant-ish text blob that contains a Matt Auto draft marker. */
export function findLatestDraftText(
  texts: readonly string[],
  marker: string = SPEC_START,
): string | undefined {
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const text = texts[i];
    if (text && includesMarker(text, marker)) return text;
  }
  return undefined;
}

function includesMarker(text: string, marker: string): boolean {
  return text.replace(/^\s+/gm, "").includes(marker);
}

function extractBetween(
  text: string,
  start: string,
  end: string,
): string | undefined {
  // Allow leading whitespace on marker lines (TUI wrap / indent artifacts).
  const startRe = new RegExp(
    `(?:^|\\n)[ \\t]*${escapeRegExp(start)}[ \\t]*(?:\\n|$)`,
  );
  const endRe = new RegExp(
    `(?:^|\\n)[ \\t]*${escapeRegExp(end)}[ \\t]*(?:\\n|$)`,
  );
  const startMatch = startRe.exec(text);
  if (!startMatch) return undefined;
  const afterStart = startMatch.index + startMatch[0].length;
  const rest = text.slice(afterStart);
  const endMatch = endRe.exec(rest);
  if (!endMatch) return undefined;
  return rest.slice(0, endMatch.index).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
