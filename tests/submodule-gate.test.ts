import { describe, expect, it } from "vitest";
import { parseGithubRepo } from "../src/adapters/submodule-gate.js";

describe("parseGithubRepo", () => {
  it("parses https and ssh GitHub remotes", () => {
    expect(
      parseGithubRepo("https://github.com/a5345534/aos-core.git"),
    ).toEqual({ owner: "a5345534", name: "aos-core" });
    expect(parseGithubRepo("https://github.com/a5345534/aos-core")).toEqual({
      owner: "a5345534",
      name: "aos-core",
    });
    expect(parseGithubRepo("git@github.com:a5345534/aos-core.git")).toEqual({
      owner: "a5345534",
      name: "aos-core",
    });
  });

  it("returns undefined for non-GitHub remotes", () => {
    expect(parseGithubRepo("https://gitlab.com/acme/repo.git")).toBeUndefined();
  });
});
