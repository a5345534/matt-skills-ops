import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

type PackageManifest = {
  devDependencies?: Record<string, string>;
};

describe("package dependency contract", () => {
  it("declares Pi TUI directly because package source imports it", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    ) as PackageManifest;

    expect(
      manifest.devDependencies?.["@earendil-works/pi-tui"],
    ).toMatch(/^\^0\.82\./);
  });
});
