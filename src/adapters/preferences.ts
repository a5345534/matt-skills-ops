import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PreferencesPort } from "../ports.js";
import type { WorkerProfile } from "../types.js";

type PreferencesFile = {
  targetBranch?: string;
  workerProfile?: WorkerProfile;
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

function isWorkerProfile(value: unknown): value is WorkerProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as WorkerProfile;
  return (
    typeof profile.modelId === "string" &&
    profile.modelId.length > 0 &&
    typeof profile.thinkingLevel === "string" &&
    profile.thinkingLevel.length > 0
  );
}

/**
 * Preferences from rebuildable Matt Auto local cache.
 * Precedence for Worker profile: Workflow-root override, then global default.
 * Target branch is Workflow-root only (global default is handled by coordinator).
 */
export function createPreferencesPort(workflowRoot: string): PreferencesPort {
  const rootPrefsPath = path.join(
    workflowRoot,
    ".pi",
    "matt-auto",
    "preferences.json",
  );
  const globalPrefsPath = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "matt-auto",
    "preferences.json",
  );

  return {
    async getConfiguredTargetBranch() {
      const root = await readPreferencesFile(rootPrefsPath);
      if (typeof root?.targetBranch === "string" && root.targetBranch.length > 0) {
        return root.targetBranch;
      }
      return undefined;
    },

    async getWorkerProfile() {
      const root = await readPreferencesFile(rootPrefsPath);
      if (isWorkerProfile(root?.workerProfile)) {
        return root.workerProfile;
      }

      const global = await readPreferencesFile(globalPrefsPath);
      if (isWorkerProfile(global?.workerProfile)) {
        return global.workerProfile;
      }

      return undefined;
    },
  };
}
