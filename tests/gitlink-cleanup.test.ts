import { describe, expect, it } from "vitest";
import {
  parseLsRemoteGitlinkLines,
} from "../src/adapters/gitlink-cleanup.js";

describe("parseLsRemoteGitlinkLines", () => {
  it("parses matt-auto/gitlink heads and ignores others", () => {
    const stdout = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/matt-auto/gitlink/aaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/main",
      "cccccccccccccccccccccccccccccccccccccccc\trefs/heads/matt-auto/gitlink/cccccccccccc",
      "dddddddddddddddddddddddddddddddddddddddd\trefs/tags/v1",
      "",
    ].join("\n");
    expect(parseLsRemoteGitlinkLines(stdout)).toEqual([
      {
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        branch: "matt-auto/gitlink/aaaaaaaaaaaa",
      },
      {
        sha: "cccccccccccccccccccccccccccccccccccccccc",
        branch: "matt-auto/gitlink/cccccccccccc",
      },
    ]);
  });
});
