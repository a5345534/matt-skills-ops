import { describe, expect, it } from "vitest";
import { parseIssueNumberFromCreateOutput } from "../src/adapters/tracker.js";

describe("parseIssueNumberFromCreateOutput", () => {
  it("parses the issue number from a classic gh issue create URL", () => {
    expect(
      parseIssueNumberFromCreateOutput(
        "https://github.com/a5345534/matt-skills-ops/issues/42\n",
      ),
    ).toBe(42);
  });

  it("parses when the URL is surrounded by other text", () => {
    expect(
      parseIssueNumberFromCreateOutput(
        "Creating issue in a5345534/matt-skills-ops\nhttps://github.com/a5345534/matt-skills-ops/issues/7\n",
      ),
    ).toBe(7);
  });

  it("returns undefined when no issue URL is present", () => {
    expect(parseIssueNumberFromCreateOutput("ok")).toBeUndefined();
  });
});
