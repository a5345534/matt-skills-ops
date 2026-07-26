import { describe, expect, it } from "vitest";
import {
  isPublishableSpecDraft,
  parseMarkedSpecDraftFromTexts,
  parseMarkedTicketsDraftFromTexts,
  parseSpecDraftFromAssistantText,
  parseTicketsDraftFromAssistantText,
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
