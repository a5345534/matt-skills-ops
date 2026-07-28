import { describe, expect, it } from "vitest";
import {
  buildCreateSpecSkillPrompt,
  isPublishableSpecDraft,
  parseMarkedSpecDraftFromTexts,
  parseMarkedTicketsDraftFromTexts,
  parseSpecDraftFromAssistantText,
  parseTicketsDraftFromAssistantText,
  validateCreateSpecMarkdown,
  validateLatestCreateSpecMarkdown,
} from "../src/adapters/planning-draft.js";

describe("isPublishableSpecDraft", () => {
  it("rejects the editor placeholder title", () => {
    expect(
      isPublishableSpecDraft({
        title: "Spec title on the first line",
        body: "## Problem Statement\n\n## Solution\n",
      }),
    ).toBe(false);
  });

  it("accepts a real draft", () => {
    expect(
      isPublishableSpecDraft({
        title: "Add dark mode toggle",
        body: [
          "## Problem Statement",
          "Users cannot switch themes at night.",
          "",
          "## Solution",
          "Add a settings toggle that persists preference.",
        ].join("\n"),
      }),
    ).toBe(true);
  });
});

const bpmnDepth3PlainSpec = `# Parametric residual depth-3 host-arm chain closed loop

## Problem Statement

BPMN Drawer needs a bounded non-exact recognition path for a depth-3 host-arm chain so requirement text does not need fixture-identical wording.

## Solution

Add a deterministic residual recognizer and inside-out merge chain while preserving exact-shape priority and fail-closed near misses.

## User Stories

1. As an external Agent operator, I can generate a depth-3 host-arm chain without selecting a pattern.
2. As a product maintainer, I can retain exact governed shapes ahead of residual recognition.
3. As a requirements author, I can receive a clear rejection for out-of-bounds near misses.

## Implementation Decisions

- Add recognition at the B1 seam after exact governed shapes and before shallower residual paths.
- Build the ProcessSpec with an inside-out merge chain at the B3 seam.

## Testing Decisions

- Cover positive depth-3 examples, exact-priority regressions, and fail-closed near misses.
- Verify normal pipeline generation produces a valid diagram without a pattern id.

## Out of Scope

Depth-4 recognition, arbitrary binary trees, and free-form paragraph parsing remain out of scope.

## Further Notes

This is a bounded follow-on to the existing single-decision and depth-2 residual paths.`;

describe("validateCreateSpecMarkdown", () => {
  it("accepts the envelope-free BPMN depth-3 response shape", () => {
    const result = validateCreateSpecMarkdown(bpmnDepth3PlainSpec);
    expect(result).toMatchObject({
      ok: true,
      draft: {
        title: "Parametric residual depth-3 host-arm chain closed loop",
      },
    });
    if (result.ok) {
      expect(result.draft.body).toContain("## Testing Decisions");
    }
  });

  it("validates only the latest non-empty assistant response", () => {
    const result = validateLatestCreateSpecMarkdown([
      "# Earlier response\n\n## Problem Statement\nNot a complete spec.",
      "",
      bpmnDepth3PlainSpec,
    ]);
    expect(result).toMatchObject({
      ok: true,
      draft: {
        title: "Parametric residual depth-3 host-arm chain closed loop",
      },
    });
  });

  it("does not fall back to an earlier valid response after a newer marker response", () => {
    const result = validateLatestCreateSpecMarkdown([
      bpmnDepth3PlainSpec,
      "---MATT-AUTO-SPEC-DRAFT---\nTITLE: stale draft",
    ]);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues).toContain(
        "Model output must not contain Matt Auto protocol markers.",
      );
    }
  });

  it("rejects protocol markers rather than compatibly accepting malformed ones", () => {
    const malformed = [
      "---MATT-AUTO-SPEC-DRAFT---",
      "TITLE: Parametric residual depth-3 host-arm chain closed loop",
      "BODY:",
      bpmnDepth3PlainSpec,
      "---END-MATT-AUTO-SPEC-DRAFT",
    ].join("\n");
    const result = validateCreateSpecMarkdown(malformed);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues).toContain(
        "Model output must not contain Matt Auto protocol markers.",
      );
    }
    expect(parseMarkedSpecDraftFromTexts([malformed])).toBeUndefined();
  });

  it("reports missing required sections and insufficient user stories", () => {
    const incomplete = bpmnDepth3PlainSpec
      .replace(/\n## Testing Decisions[\s\S]*?(?=\n## Out of Scope)/, "")
      .replace(/\n2\. [^\n]*\n3\. [^\n]*/, "");
    const result = validateCreateSpecMarkdown(incomplete);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues).toContain("Missing required section: Testing Decisions.");
      expect(result.issues).toContain(
        "User Stories must contain at least 3 numbered stories.",
      );
    }
  });

  it("rejects fenced output even when it otherwise has all required sections", () => {
    const result = validateCreateSpecMarkdown(
      `\`\`\`markdown\n${bpmnDepth3PlainSpec}\n\`\`\``,
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues).toContain(
        "Model output must not contain fenced code blocks.",
      );
    }
  });

  it("asks the model for plain Markdown, never protocol markers", () => {
    const prompt = buildCreateSpecSkillPrompt();
    expect(prompt).toContain("# <concise spec title>");
    expect(prompt).toContain("## Implementation Decisions");
    expect(prompt).toContain("## Testing Decisions");
    expect(prompt).toContain(
      "at least 3 top-level numbered entries (`1. ...`, `2. ...`, `3. ...`)",
    );
    expect(prompt).not.toContain("MATT-AUTO-SPEC-DRAFT");
  });
});

describe("parseSpecDraftFromAssistantText", () => {
  it("parses Matt Auto markers", () => {
    const text = `
Some preamble

---MATT-AUTO-SPEC-DRAFT---
TITLE: Add export to CSV
BODY:
## Problem Statement
Need CSV export for reports.

## Solution
Add an export button on the reports page.
---END-MATT-AUTO-SPEC-DRAFT---
`;
    expect(parseSpecDraftFromAssistantText(text)).toEqual({
      title: "Add export to CSV",
      body: [
        "## Problem Statement",
        "Need CSV export for reports.",
        "",
        "## Solution",
        "Add an export button on the reports page.",
      ].join("\n"),
    });
  });

  it("parses markers even when TITLE/BODY lines have leading spaces", () => {
    const text = `
---MATT-AUTO-SPEC-DRAFT---
 TITLE: Platform web-browsing tools (fetch_url + read_html) with governed enablement
 BODY:

 Problem Statement

 Operators ask the digital employee to obtain web-browsing ability (often phrased as apply for a web tool). Today there is no real platform runtime.
---END-MATT-AUTO-SPEC-DRAFT---
`;
    const draft = parseSpecDraftFromAssistantText(text);
    expect(draft?.title).toMatch(/Platform web-browsing tools/);
    expect(draft?.body).toMatch(/Operators ask the digital employee/);
  });
});

describe("parseTicketsDraftFromAssistantText", () => {
  it("parses JSON tickets from markers", () => {
    const text = `
---MATT-AUTO-TICKETS-DRAFT---
\`\`\`json
{
  "tickets": [
    {
      "localId": "1",
      "title": "Schema",
      "body": "## What to build\\nAdd table\\n\\n## Acceptance criteria\\n- [ ] Migrates",
      "blockedBy": []
    },
    {
      "localId": "2",
      "title": "API",
      "body": "## What to build\\nExpose endpoint",
      "blockedBy": ["1"]
    }
  ]
}
\`\`\`
---END-MATT-AUTO-TICKETS-DRAFT---
`;
    const draft = parseTicketsDraftFromAssistantText(text);
    expect(draft?.tickets).toHaveLength(2);
    expect(draft?.tickets[0]?.localId).toBe("1");
    expect(draft?.tickets[1]?.blockedBy).toEqual(["1"]);
  });
});

describe("parseMarkedSpecDraftFromTexts", () => {
  const marked = `
---MATT-AUTO-SPEC-DRAFT---
TITLE: Run brief UI
BODY:
## Problem Statement

Operators cannot see pipeline progress during /matt-auto run waits.

## Solution

Show a full-screen read-only brief with Pause, Resume, and Terminate.
---END-MATT-AUTO-SPEC-DRAFT---
`;

  it("finds a marked draft among prior assistant texts", () => {
    const draft = parseMarkedSpecDraftFromTexts([
      "grill consensus only",
      marked,
      "ok shall we implement?",
    ]);
    expect(draft?.title).toBe("Run brief UI");
    expect(draft?.body).toMatch(/full-screen read-only brief/);
  });

  it("ignores marker-less first-line fallback for auto-publish safety", () => {
    expect(
      parseMarkedSpecDraftFromTexts([
        "已提交並推送。\n\nSome body that is long enough to look real but has no markers at all here.",
      ]),
    ).toBeUndefined();
  });

  it("respects recentWindow so ancient marked drafts are ignored", () => {
    expect(
      parseMarkedSpecDraftFromTexts(
        [marked, "a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
        { recentWindow: 3 },
      ),
    ).toBeUndefined();
  });
});

describe("parseMarkedTicketsDraftFromTexts", () => {
  it("requires tickets markers", () => {
    const text = `
---MATT-AUTO-TICKETS-DRAFT---
\`\`\`json
{
  "tickets": [
    {
      "localId": "1",
      "title": "Brief wait loop",
      "body": "## What to build\\n\\nFull-screen brief.\\n\\n## Acceptance criteria\\n- [ ] Shows workers",
      "blockedBy": []
    }
  ]
}
\`\`\`
---END-MATT-AUTO-TICKETS-DRAFT---
`;
    const draft = parseMarkedTicketsDraftFromTexts(["noise", text]);
    expect(draft?.tickets).toHaveLength(1);
    expect(draft?.tickets[0]?.localId).toBe("1");
  });
});
