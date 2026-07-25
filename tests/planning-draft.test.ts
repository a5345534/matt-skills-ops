import { describe, expect, it } from "vitest";
import {
  isPublishableSpecDraft,
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
