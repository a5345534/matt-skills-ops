import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_LIVE_WAIT_POLL_INTERVAL_MS,
  DEFAULT_WORKER_CONCURRENCY,
  MAX_LIVE_WAIT_POLL_INTERVAL_MS,
  MIN_LIVE_WAIT_POLL_INTERVAL_MS,
} from "../constants.js";
import {
  canonicalTargetIdentitiesEqual,
  canonicalTargetIdentityKey,
  isCanonicalTargetIdentity,
} from "../coordination.js";
import type { PreferencesPort } from "../ports.js";
import type {
  CanonicalTargetIdentity,
  WorkerProfile,
  WorkflowHomeBinding,
} from "../types.js";

type PreferencesFile = {
  targetBranch?: string;
  workerProfile?: WorkerProfile;
  /** Optional positive integer Worker concurrency for this prefs layer. */
  workerConcurrency?: number;
  /** Optional live run-brief poll interval in milliseconds for this prefs layer. */
  liveWaitPollIntervalMs?: number;
  /** Target branch → Active Workflow ID (legacy rebuildable local cache). */
  activeWorkflowIds?: Record<string, number>;
  /** Canonical Target identity → checkout-local Workflow-home routing binding. */
  workflowHomeBindings?: Record<string, WorkflowHomeBinding>;
};

/** True when value is a positive integer (>= 1). */
export function isValidWorkerConcurrency(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * Reject non-integers and values < 1 for Worker concurrency writes.
 */
export function assertValidWorkerConcurrency(
  value: unknown,
): asserts value is number {
  if (!isValidWorkerConcurrency(value)) {
    throw new Error("Worker concurrency must be a positive integer (>= 1).");
  }
}

/** Where an effective Worker concurrency value was resolved from. */
export type WorkerConcurrencySource =
  | "workflow-root"
  | "global"
  | "default";

/** Where an effective live-wait poll interval was resolved from. */
export type LiveWaitPollIntervalSource =
  | "workflow-root"
  | "global"
  | "default";

export type ResolvedLiveWaitPollInterval = {
  intervalMs: number;
  source: LiveWaitPollIntervalSource;
};

/** True when value is an integer within the live-wait poll interval bounds. */
export function isValidLiveWaitPollIntervalMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_LIVE_WAIT_POLL_INTERVAL_MS &&
    value <= MAX_LIVE_WAIT_POLL_INTERVAL_MS
  );
}

export function assertValidLiveWaitPollIntervalMs(
  value: unknown,
): asserts value is number {
  if (!isValidLiveWaitPollIntervalMs(value)) {
    throw new Error(
      `Live wait poll interval must be an integer between ${MIN_LIVE_WAIT_POLL_INTERVAL_MS} and ${MAX_LIVE_WAIT_POLL_INTERVAL_MS} ms.`,
    );
  }
}

/** Resolve live-wait poll interval: root → global → default 500ms. */
export function resolveLiveWaitPollInterval(
  root: number | undefined,
  global: number | undefined,
  defaultValue: number = DEFAULT_LIVE_WAIT_POLL_INTERVAL_MS,
): ResolvedLiveWaitPollInterval {
  if (isValidLiveWaitPollIntervalMs(root)) {
    return { intervalMs: root, source: "workflow-root" };
  }
  if (isValidLiveWaitPollIntervalMs(global)) {
    return { intervalMs: global, source: "global" };
  }
  return { intervalMs: defaultValue, source: "default" };
}

/** Effective Worker concurrency with the layer that supplied it. */
export type ResolvedWorkerConcurrency = {
  concurrency: number;
  source: WorkerConcurrencySource;
};

/**
 * Resolve effective Worker concurrency with source: root → global → default 2.
 * Callers pass only validated or sanitized layer values.
 */
export function resolveWorkerConcurrency(
  root: number | undefined,
  global: number | undefined,
  defaultValue: number = DEFAULT_WORKER_CONCURRENCY,
): ResolvedWorkerConcurrency {
  if (isValidWorkerConcurrency(root)) {
    return { concurrency: root, source: "workflow-root" };
  }
  if (isValidWorkerConcurrency(global)) {
    return { concurrency: global, source: "global" };
  }
  return { concurrency: defaultValue, source: "default" };
}

/**
 * Resolve effective Worker concurrency: root → global → default 2.
 * Callers pass only validated or sanitized layer values.
 */
export function resolveEffectiveWorkerConcurrency(
  root: number | undefined,
  global: number | undefined,
  defaultValue: number = DEFAULT_WORKER_CONCURRENCY,
): number {
  return resolveWorkerConcurrency(root, global, defaultValue).concurrency;
}

async function readPreferencesFile(
  filePath: string,
): Promise<PreferencesFile | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as PreferencesFile;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writePreferencesFile(
  filePath: string,
  next: PreferencesFile,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function isWorkerProfile(value: unknown): value is WorkerProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as WorkerProfile;
  return (
    typeof profile.provider === "string" &&
    profile.provider.length > 0 &&
    typeof profile.modelId === "string" &&
    profile.modelId.length > 0 &&
    typeof profile.thinkingLevel === "string" &&
    profile.thinkingLevel.length > 0
  );
}

function isWorkflowHomeBinding(value: unknown): value is WorkflowHomeBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as WorkflowHomeBinding;
  return (
    isCanonicalTargetIdentity(binding.target) &&
    typeof binding.workflowId === "number" &&
    Number.isInteger(binding.workflowId) &&
    binding.workflowId > 0
  );
}

function copyTarget(target: CanonicalTargetIdentity): CanonicalTargetIdentity {
  return {
    repository: { ...target.repository },
    targetRef: target.targetRef,
  };
}

function copyBinding(binding: WorkflowHomeBinding): WorkflowHomeBinding {
  return { target: copyTarget(binding.target), workflowId: binding.workflowId };
}

function preferencesPaths(workflowRoot: string): {
  rootPrefsPath: string;
  globalPrefsPath: string;
} {
  return {
    rootPrefsPath: path.join(
      workflowRoot,
      ".pi",
      "matt-auto",
      "preferences.json",
    ),
    globalPrefsPath: path.join(
      os.homedir(),
      ".pi",
      "agent",
      "matt-auto",
      "preferences.json",
    ),
  };
}

/**
 * Preferences from rebuildable Matt Auto local cache.
 * Layers are stored separately; the Workflow coordinator resolves precedence.
 * Target branch is Workflow-root only (global default is handled by coordinator).
 */
export function createPreferencesPort(workflowRoot: string): PreferencesPort {
  const { rootPrefsPath, globalPrefsPath } = preferencesPaths(workflowRoot);

  return {
    async getConfiguredTargetBranch() {
      const root = await readPreferencesFile(rootPrefsPath);
      if (typeof root?.targetBranch === "string" && root.targetBranch.length > 0) {
        return root.targetBranch;
      }
      return undefined;
    },

    async getGlobalWorkerProfile() {
      const global = await readPreferencesFile(globalPrefsPath);
      if (isWorkerProfile(global?.workerProfile)) {
        return global.workerProfile;
      }
      return undefined;
    },

    async getRootWorkerProfile() {
      const root = await readPreferencesFile(rootPrefsPath);
      if (isWorkerProfile(root?.workerProfile)) {
        return root.workerProfile;
      }
      return undefined;
    },

    async getWorkflowSnapshotWorkerProfile() {
      // Workflow-manifest snapshot lands with Create-spec / Active workflow tickets.
      return undefined;
    },

    async setGlobalWorkerProfile(profile: WorkerProfile) {
      if (!isWorkerProfile(profile)) {
        throw new Error("Invalid Worker profile.");
      }
      const existing = (await readPreferencesFile(globalPrefsPath)) ?? {};
      await writePreferencesFile(globalPrefsPath, {
        ...existing,
        workerProfile: {
          provider: profile.provider,
          modelId: profile.modelId,
          thinkingLevel: profile.thinkingLevel,
        },
      });
    },

    async setRootWorkerProfile(profile: WorkerProfile) {
      if (!isWorkerProfile(profile)) {
        throw new Error("Invalid Worker profile.");
      }
      const existing = (await readPreferencesFile(rootPrefsPath)) ?? {};
      await writePreferencesFile(rootPrefsPath, {
        ...existing,
        workerProfile: {
          provider: profile.provider,
          modelId: profile.modelId,
          thinkingLevel: profile.thinkingLevel,
        },
      });
    },

    async clearRootWorkerProfile() {
      const existing = await readPreferencesFile(rootPrefsPath);
      if (!existing || existing.workerProfile === undefined) {
        return;
      }
      const { workerProfile: _removed, ...rest } = existing;
      await writePreferencesFile(rootPrefsPath, rest);
    },

    async getGlobalWorkerConcurrency() {
      const global = await readPreferencesFile(globalPrefsPath);
      return isValidWorkerConcurrency(global?.workerConcurrency)
        ? global.workerConcurrency
        : undefined;
    },

    async getRootWorkerConcurrency() {
      const root = await readPreferencesFile(rootPrefsPath);
      return isValidWorkerConcurrency(root?.workerConcurrency)
        ? root.workerConcurrency
        : undefined;
    },

    async setGlobalWorkerConcurrency(concurrency: number) {
      assertValidWorkerConcurrency(concurrency);
      const existing = (await readPreferencesFile(globalPrefsPath)) ?? {};
      await writePreferencesFile(globalPrefsPath, {
        ...existing,
        workerConcurrency: concurrency,
      });
    },

    async setRootWorkerConcurrency(concurrency: number) {
      assertValidWorkerConcurrency(concurrency);
      const existing = (await readPreferencesFile(rootPrefsPath)) ?? {};
      await writePreferencesFile(rootPrefsPath, {
        ...existing,
        workerConcurrency: concurrency,
      });
    },

    async clearRootWorkerConcurrency() {
      const existing = await readPreferencesFile(rootPrefsPath);
      if (!existing || existing.workerConcurrency === undefined) {
        return;
      }
      const { workerConcurrency: _removed, ...rest } = existing;
      await writePreferencesFile(rootPrefsPath, rest);
    },

    async getGlobalLiveWaitPollIntervalMs() {
      const global = await readPreferencesFile(globalPrefsPath);
      return isValidLiveWaitPollIntervalMs(global?.liveWaitPollIntervalMs)
        ? global.liveWaitPollIntervalMs
        : undefined;
    },

    async getRootLiveWaitPollIntervalMs() {
      const root = await readPreferencesFile(rootPrefsPath);
      return isValidLiveWaitPollIntervalMs(root?.liveWaitPollIntervalMs)
        ? root.liveWaitPollIntervalMs
        : undefined;
    },

    async setGlobalLiveWaitPollIntervalMs(intervalMs: number) {
      assertValidLiveWaitPollIntervalMs(intervalMs);
      const existing = (await readPreferencesFile(globalPrefsPath)) ?? {};
      await writePreferencesFile(globalPrefsPath, {
        ...existing,
        liveWaitPollIntervalMs: intervalMs,
      });
    },

    async setRootLiveWaitPollIntervalMs(intervalMs: number) {
      assertValidLiveWaitPollIntervalMs(intervalMs);
      const existing = (await readPreferencesFile(rootPrefsPath)) ?? {};
      await writePreferencesFile(rootPrefsPath, {
        ...existing,
        liveWaitPollIntervalMs: intervalMs,
      });
    },

    async clearRootLiveWaitPollIntervalMs() {
      const existing = await readPreferencesFile(rootPrefsPath);
      if (!existing || existing.liveWaitPollIntervalMs === undefined) {
        return;
      }
      const { liveWaitPollIntervalMs: _removed, ...rest } = existing;
      await writePreferencesFile(rootPrefsPath, rest);
    },

    async getActiveWorkflowId(targetBranch: string) {
      const root = await readPreferencesFile(rootPrefsPath);
      const id = root?.activeWorkflowIds?.[targetBranch];
      return typeof id === "number" && Number.isInteger(id) && id > 0
        ? id
        : undefined;
    },

    async setActiveWorkflowId(targetBranch: string, workflowId: number) {
      const existing = (await readPreferencesFile(rootPrefsPath)) ?? {};
      await writePreferencesFile(rootPrefsPath, {
        ...existing,
        activeWorkflowIds: {
          ...(existing.activeWorkflowIds ?? {}),
          [targetBranch]: workflowId,
        },
      });
    },

    async clearActiveWorkflowId(targetBranch: string) {
      const existing = await readPreferencesFile(rootPrefsPath);
      if (!existing?.activeWorkflowIds?.[targetBranch]) return;
      const { [targetBranch]: _removed, ...rest } =
        existing.activeWorkflowIds;
      const next: PreferencesFile = { ...existing };
      if (Object.keys(rest).length === 0) {
        delete next.activeWorkflowIds;
      } else {
        next.activeWorkflowIds = rest;
      }
      await writePreferencesFile(rootPrefsPath, next);
    },

    async getWorkflowHomeBinding(target) {
      if (!isCanonicalTargetIdentity(target)) return undefined;
      const root = await readPreferencesFile(rootPrefsPath);
      const binding = root?.workflowHomeBindings?.[
        canonicalTargetIdentityKey(target)
      ];
      if (!isWorkflowHomeBinding(binding)) return undefined;
      return canonicalTargetIdentitiesEqual(binding.target, target)
        ? copyBinding(binding)
        : undefined;
    },

    async setWorkflowHomeBinding(binding) {
      if (!isWorkflowHomeBinding(binding)) {
        throw new Error("Workflow-home binding requires a canonical Target identity and positive Workflow ID.");
      }
      const existing = (await readPreferencesFile(rootPrefsPath)) ?? {};
      const key = canonicalTargetIdentityKey(binding.target);
      await writePreferencesFile(rootPrefsPath, {
        ...existing,
        workflowHomeBindings: {
          ...(existing.workflowHomeBindings ?? {}),
          [key]: copyBinding(binding),
        },
      });
    },

    async clearWorkflowHomeBinding(target) {
      if (!isCanonicalTargetIdentity(target)) return;
      const existing = await readPreferencesFile(rootPrefsPath);
      const key = canonicalTargetIdentityKey(target);
      if (!existing?.workflowHomeBindings?.[key]) return;
      const { [key]: _removed, ...rest } = existing.workflowHomeBindings;
      const next: PreferencesFile = { ...existing };
      if (Object.keys(rest).length === 0) {
        delete next.workflowHomeBindings;
      } else {
        next.workflowHomeBindings = rest;
      }
      await writePreferencesFile(rootPrefsPath, next);
    },
  };
}
