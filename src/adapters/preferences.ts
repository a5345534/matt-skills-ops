import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PreferencesPort } from "../ports.js";
import type { WorkerProfile } from "../types.js";

type PreferencesFile = {
  targetBranch?: string;
  workerProfile?: WorkerProfile;
  /** Target branch → Active Workflow ID (rebuildable local cache). */
  activeWorkflowIds?: Record<string, number>;
};

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
  };
}
