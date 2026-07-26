import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertValidWorkerConcurrency,
  createPreferencesPort,
  isValidWorkerConcurrency,
  resolveEffectiveWorkerConcurrency,
} from "../src/adapters/preferences.js";
import {
  DEFAULT_WORKER_CONCURRENCY,
  WORKER_CONCURRENCY_WARNING_THRESHOLD,
} from "../src/constants.js";

const tempDirs: string[] = [];
const homedirSpies: Array<ReturnType<typeof vi.spyOn>> = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function tempWorkflowRoot(): Promise<string> {
  return tempDir("matt-auto-prefs-");
}

/** Point os.homedir at an isolated temp home for global prefs. */
async function isolateHome(): Promise<string> {
  const home = await tempDir("matt-auto-home-");
  const spy = vi.spyOn(os, "homedir").mockReturnValue(home);
  homedirSpies.push(spy);
  return home;
}

afterEach(async () => {
  while (homedirSpies.length > 0) {
    homedirSpies.pop()?.mockRestore();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("Worker concurrency validation helpers", () => {
  it("accepts positive integers only", () => {
    expect(isValidWorkerConcurrency(1)).toBe(true);
    expect(isValidWorkerConcurrency(2)).toBe(true);
    expect(isValidWorkerConcurrency(99)).toBe(true);

    expect(isValidWorkerConcurrency(0)).toBe(false);
    expect(isValidWorkerConcurrency(-1)).toBe(false);
    expect(isValidWorkerConcurrency(1.5)).toBe(false);
    expect(isValidWorkerConcurrency(NaN)).toBe(false);
    expect(isValidWorkerConcurrency(Infinity)).toBe(false);
    expect(isValidWorkerConcurrency("2")).toBe(false);
    expect(isValidWorkerConcurrency(null)).toBe(false);
    expect(isValidWorkerConcurrency(undefined)).toBe(false);
  });

  it("assertValidWorkerConcurrency rejects invalid values", () => {
    expect(() => assertValidWorkerConcurrency(0)).toThrow(/positive integer/i);
    expect(() => assertValidWorkerConcurrency(1.2)).toThrow(/positive integer/i);
    expect(() => assertValidWorkerConcurrency(-3)).toThrow(/positive integer/i);
    expect(() => assertValidWorkerConcurrency(4)).not.toThrow();
  });
});

describe("resolveEffectiveWorkerConcurrency", () => {
  it("defaults to 2 when both layers are unset", () => {
    expect(resolveEffectiveWorkerConcurrency(undefined, undefined)).toBe(
      DEFAULT_WORKER_CONCURRENCY,
    );
    expect(DEFAULT_WORKER_CONCURRENCY).toBe(2);
  });

  it("uses global when root is unset", () => {
    expect(resolveEffectiveWorkerConcurrency(undefined, 3)).toBe(3);
  });

  it("prefers root over global", () => {
    expect(resolveEffectiveWorkerConcurrency(5, 3)).toBe(5);
  });

  it("ignores invalid layer values and falls through", () => {
    expect(resolveEffectiveWorkerConcurrency(0 as unknown as number, 3)).toBe(
      3,
    );
    expect(
      resolveEffectiveWorkerConcurrency(
        1.5 as unknown as number,
        0 as unknown as number,
      ),
    ).toBe(DEFAULT_WORKER_CONCURRENCY);
  });
});

describe("WORKER_CONCURRENCY_WARNING_THRESHOLD", () => {
  it("exports the fixed configure-UI threshold of 4", () => {
    expect(WORKER_CONCURRENCY_WARNING_THRESHOLD).toBe(4);
  });
});

describe("PreferencesPort Worker concurrency persistence", () => {
  it("persists global and root concurrency in local prefs files only", async () => {
    const home = await isolateHome();
    const workflowRoot = await tempWorkflowRoot();
    const prefs = createPreferencesPort(workflowRoot);

    await expect(prefs.getGlobalWorkerConcurrency()).resolves.toBeUndefined();
    await expect(prefs.getRootWorkerConcurrency()).resolves.toBeUndefined();

    await prefs.setGlobalWorkerConcurrency(3);
    await prefs.setRootWorkerConcurrency(7);

    await expect(prefs.getGlobalWorkerConcurrency()).resolves.toBe(3);
    await expect(prefs.getRootWorkerConcurrency()).resolves.toBe(7);

    const rootFile = path.join(
      workflowRoot,
      ".pi",
      "matt-auto",
      "preferences.json",
    );
    const rootJson = JSON.parse(await readFile(rootFile, "utf8")) as {
      workerConcurrency?: number;
    };
    expect(rootJson.workerConcurrency).toBe(7);

    const globalFile = path.join(
      home,
      ".pi",
      "agent",
      "matt-auto",
      "preferences.json",
    );
    const globalJson = JSON.parse(await readFile(globalFile, "utf8")) as {
      workerConcurrency?: number;
    };
    expect(globalJson.workerConcurrency).toBe(3);

    // Global is shared across Workflow roots; root override stays root-local.
    const otherRoot = await tempWorkflowRoot();
    const otherPrefs = createPreferencesPort(otherRoot);
    await expect(otherPrefs.getGlobalWorkerConcurrency()).resolves.toBe(3);
    await expect(otherPrefs.getRootWorkerConcurrency()).resolves.toBeUndefined();
  });

  it("rejects invalid values on set and leaves prior value intact", async () => {
    await isolateHome();
    const workflowRoot = await tempWorkflowRoot();
    const prefs = createPreferencesPort(workflowRoot);

    await prefs.setGlobalWorkerConcurrency(2);
    await expect(prefs.setGlobalWorkerConcurrency(0)).rejects.toThrow(
      /positive integer/i,
    );
    await expect(prefs.setGlobalWorkerConcurrency(1.5)).rejects.toThrow(
      /positive integer/i,
    );
    await expect(prefs.setRootWorkerConcurrency(-1)).rejects.toThrow(
      /positive integer/i,
    );

    await expect(prefs.getGlobalWorkerConcurrency()).resolves.toBe(2);
    await expect(prefs.getRootWorkerConcurrency()).resolves.toBeUndefined();
  });

  it("clears the root concurrency override", async () => {
    await isolateHome();
    const workflowRoot = await tempWorkflowRoot();
    const prefs = createPreferencesPort(workflowRoot);

    await prefs.setRootWorkerConcurrency(9);
    await prefs.clearRootWorkerConcurrency();
    await expect(prefs.getRootWorkerConcurrency()).resolves.toBeUndefined();

    const rootFile = path.join(
      workflowRoot,
      ".pi",
      "matt-auto",
      "preferences.json",
    );
    const rootJson = JSON.parse(await readFile(rootFile, "utf8")) as Record<
      string,
      unknown
    >;
    expect(rootJson.workerConcurrency).toBeUndefined();
  });

  it("treats invalid stored concurrency as unset", async () => {
    const workflowRoot = await tempWorkflowRoot();
    const rootDir = path.join(workflowRoot, ".pi", "matt-auto");
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      path.join(rootDir, "preferences.json"),
      `${JSON.stringify({ workerConcurrency: 0 }, null, 2)}\n`,
      "utf8",
    );

    const prefs = createPreferencesPort(workflowRoot);
    await expect(prefs.getRootWorkerConcurrency()).resolves.toBeUndefined();
  });
});
