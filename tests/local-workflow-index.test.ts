import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listLocalUnfinishedWorkflows } from "../src/adapters/local-workflow-index.js";

const temps: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "matt-auto-local-index-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("listLocalUnfinishedWorkflows", () => {
  it("returns empty when the checkout has no local Matt Auto state", async () => {
    const root = await tempRoot();
    await expect(listLocalUnfinishedWorkflows(root)).resolves.toEqual([]);
  });

  it("lists bound, legacy-pointer, and transcript workflow ids without GitHub", async () => {
    const root = await tempRoot();
    const prefsDir = path.join(root, ".pi", "matt-auto");
    await mkdir(prefsDir, { recursive: true });
    await writeFile(
      path.join(prefsDir, "preferences.json"),
      JSON.stringify({
        activeWorkflowIds: { main: 38 },
        workflowHomeBindings: {
          "github.com/acme/app|refs/heads/main": {
            target: {
              repository: { owner: "acme", name: "app" },
              targetRef: "refs/heads/main",
            },
            workflowId: 12,
          },
        },
      }),
      "utf8",
    );
    await mkdir(path.join(prefsDir, "transcripts", "38", "ticket-44"), {
      recursive: true,
    });
    await mkdir(path.join(prefsDir, "transcripts", "99", "ticket-1"), {
      recursive: true,
    });
    await writeFile(
      path.join(prefsDir, "transcripts", "38", "ticket-44", "r1.jsonl"),
      "{}\n",
      "utf8",
    );

    const listed = await listLocalUnfinishedWorkflows(root);
    expect(listed.map((item) => item.workflowId)).toEqual([12, 38, 99]);
    expect(listed.find((item) => item.workflowId === 38)).toMatchObject({
      bound: true,
      sources: expect.arrayContaining(["legacy-pointer", "transcripts"]),
      label: expect.stringContaining("Workflow #38"),
    });
    expect(listed.find((item) => item.workflowId === 99)).toMatchObject({
      bound: false,
      sources: ["transcripts"],
    });
    expect(listed.find((item) => item.workflowId === 12)).toMatchObject({
      bound: true,
      sources: ["binding"],
    });
  });
});
