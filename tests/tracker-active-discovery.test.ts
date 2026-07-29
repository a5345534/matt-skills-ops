import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTrackerPort,
  formatWorkflowManifestComment,
  parsePaginatedApiArray,
} from "../src/adapters/tracker.js";
import type {
  CanonicalTargetIdentity,
  CoordinationWorkflowManifest,
  LegacyWorkflowManifest,
} from "../src/types.js";

const target: CanonicalTargetIdentity = {
  repository: { owner: "Acme", name: "workflow-tools" },
  targetRef: "refs/heads/main",
};

const workerProfile = {
  provider: "openai-codex",
  modelId: "gpt-5.6-terra",
  thinkingLevel: "max",
};

function legacyManifest(workflowId: number): LegacyWorkflowManifest {
  return {
    schema: "matt-auto/workflow-manifest",
    version: 1,
    workflowId,
    targetBranch: "main",
    stage: "spec-published",
    workerProfile,
  };
}

function coordinatedManifest(workflowId: number): CoordinationWorkflowManifest {
  return {
    schema: "matt-auto/workflow-manifest",
    version: 2,
    workflowId,
    targetBranch: "main",
    stage: "pr-opened",
    workerProfile,
    coordination: { target },
  };
}

describe("parsePaginatedApiArray", () => {
  it("accepts a flat merged page (gh without --slurp)", () => {
    expect(
      parsePaginatedApiArray(
        JSON.stringify([{ number: 1 }, { number: 2 }]),
      ),
    ).toEqual([{ number: 1 }, { number: 2 }]);
  });

  it("flattens slurp-shaped array-of-pages", () => {
    expect(
      parsePaginatedApiArray(
        JSON.stringify([[{ number: 1 }], [{ number: 2 }, { number: 3 }]]),
      ),
    ).toEqual([{ number: 1 }, { number: 2 }, { number: 3 }]);
  });

  it("treats empty stdout and empty array as success", () => {
    expect(parsePaginatedApiArray("")).toEqual([]);
    expect(parsePaginatedApiArray("[]")).toEqual([]);
  });

  it("parses concatenated page arrays", () => {
    expect(
      parsePaginatedApiArray(
        `${JSON.stringify([{ number: 1 }])}${JSON.stringify([{ number: 2 }])}`,
      ),
    ).toEqual([{ number: 1 }, { number: 2 }]);
  });
});

describe("TrackerPort.findActiveWorkflows", () => {
  it("succeeds when gh rejects --slurp and returns a flat empty list", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "matt-auto-fake-gh-noslurp-"));
    const executablePath = path.join(directory, "gh");
    const callLogPath = path.join(directory, "calls.jsonl");
    await writeFile(
      executablePath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify(args) + "\\n");
if (args.includes("--slurp")) {
  process.stderr.write("unknown flag: --slurp\\n");
  process.exit(1);
}
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ nameWithOwner: "Acme/workflow-tools" }));
  process.exit(0);
}
const endpoint = args.find((arg) => typeof arg === "string" && arg.startsWith("repos/"));
if (endpoint === "repos/Acme/workflow-tools/issues?state=open&per_page=100") {
  process.stdout.write("[]");
  process.exit(0);
}
process.stderr.write("Unexpected: " + JSON.stringify(args));
process.exit(1);
`,
      "utf8",
    );
    await chmod(executablePath, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
    try {
      const tracker = createTrackerPort(process.cwd());
      await expect(tracker.findActiveWorkflows(target)).resolves.toEqual([]);
      const calls = (await readFile(callLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.some((call) => call.includes("--slurp"))).toBe(false);
      expect(
        calls.some(
          (call) =>
            call.includes("--paginate") &&
            call.some((part) =>
              part.includes("issues?state=open&per_page=100"),
            ),
        ),
      ).toBe(true);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("paginates every open issue and returns all manifests for the canonical Target", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "matt-auto-fake-gh-"));
    const responses = {
      issuePages: [
        [
          { number: 39, title: "Legacy workflow", state: "open" },
          { number: 41, title: "Different target", state: "open" },
        ],
        [{ number: 40, title: "Coordinated workflow", state: "open" }],
      ],
      comments: {
        "39": [[{ body: formatWorkflowManifestComment(legacyManifest(39)) }]],
        "40": [[{ body: formatWorkflowManifestComment(coordinatedManifest(40)) }]],
        "41": [
          [
            {
              body: formatWorkflowManifestComment({
                ...coordinatedManifest(41),
                targetBranch: "develop",
                coordination: {
                  target: {
                    ...target,
                    targetRef: "refs/heads/develop",
                  },
                },
              }),
            },
          ],
        ],
      },
    };
    const responsePath = path.join(directory, "responses.json");
    const executablePath = path.join(directory, "gh");
    const callLogPath = path.join(directory, "calls.jsonl");
    await writeFile(responsePath, JSON.stringify(responses), "utf8");
    await writeFile(
      executablePath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const root = __dirname;
const responses = JSON.parse(fs.readFileSync(path.join(root, "responses.json"), "utf8"));
fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify(args) + "\\n");
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ nameWithOwner: "Acme/workflow-tools" }));
  process.exit(0);
}
const endpoint = args.find((arg) => arg.startsWith("repos/"));
if (endpoint === "repos/Acme/workflow-tools/issues?state=open&per_page=100") {
  process.stdout.write(JSON.stringify(responses.issuePages));
  process.exit(0);
}
const match = endpoint && /\\/issues\\/(\\d+)\\/comments\\?/.exec(endpoint);
if (match && responses.comments[match[1]]) {
  process.stdout.write(JSON.stringify(responses.comments[match[1]]));
  process.exit(0);
}
process.stderr.write("Unexpected gh arguments: " + JSON.stringify(args));
process.exit(1);
`,
      "utf8",
    );
    await chmod(executablePath, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
    try {
      const tracker = createTrackerPort(process.cwd());
      const active = await tracker.findActiveWorkflows(target);

      expect(active.map((workflow) => workflow.workflowId)).toEqual([39, 40]);
      expect(active[1]?.coordination?.target).toEqual(target);

      const calls = (await readFile(callLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const listCall = calls.find((call) =>
        call.includes("repos/Acme/workflow-tools/issues?state=open&per_page=100"),
      );
      expect(listCall).toEqual(
        expect.arrayContaining(["api", "--paginate"]),
      );
      expect(listCall).not.toEqual(expect.arrayContaining(["--slurp"]));
      expect(
        calls.filter((call) => call.some((part) => part.includes("/comments?"))),
      ).toHaveLength(3);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
