import { describe, expect, it } from "vitest";
import {
  parseIssueNumberFromCreateOutput,
  parsePullRequestFromCreateOutput,
} from "../src/adapters/tracker.js";

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

describe("parsePullRequestFromCreateOutput", () => {
  it("parses number and url from a classic gh pr create URL", () => {
    expect(
      parsePullRequestFromCreateOutput(
        "https://github.com/a5345534/aos/pull/99\n",
      ),
    ).toEqual({
      number: 99,
      url: "https://github.com/a5345534/aos/pull/99",
    });
  });

  it("parses when the URL is surrounded by other text", () => {
    expect(
      parsePullRequestFromCreateOutput(
        "Creating pull request for a5345534/aos\nhttps://github.com/a5345534/aos/pull/13\n",
      ),
    ).toEqual({
      number: 13,
      url: "https://github.com/a5345534/aos/pull/13",
    });
  });

  it("returns undefined when no pull request URL is present", () => {
    expect(parsePullRequestFromCreateOutput("ok")).toBeUndefined();
  });
});
