import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalTargetIdentityKey,
  isCanonicalTargetIdentity,
} from "../coordination.js";
import type {
  LocalUnfinishedWorkflow,
  LocalUnfinishedWorkflowSource,
  WorkflowHomeBinding,
} from "../types.js";

export type { LocalUnfinishedWorkflow, LocalUnfinishedWorkflowSource };

type PreferencesFileShape = {
  activeWorkflowIds?: Record<string, number>;
  workflowHomeBindings?: Record<string, WorkflowHomeBinding>;
};

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function preferencesPath(workflowRoot: string): string {
  return path.join(
    path.resolve(workflowRoot),
    ".pi",
    "matt-auto",
    "preferences.json",
  );
}

function transcriptsRoot(workflowRoot: string): string {
  return path.join(path.resolve(workflowRoot), ".pi", "matt-auto", "transcripts");
}

async function readPreferencesFile(
  workflowRoot: string,
): Promise<PreferencesFileShape | undefined> {
  try {
    const raw = await readFile(preferencesPath(workflowRoot), "utf8");
    return JSON.parse(raw) as PreferencesFileShape;
  } catch {
    return undefined;
  }
}

async function listTranscriptWorkflowIds(
  workflowRoot: string,
): Promise<number[]> {
  try {
    const entries = await readdir(transcriptsRoot(workflowRoot), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter(isPositiveInt)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function formatLocalLabel(
  workflowId: number,
  sources: ReadonlySet<LocalUnfinishedWorkflowSource>,
): string {
  const tags: string[] = [];
  if (sources.has("binding") || sources.has("legacy-pointer")) {
    tags.push("bound");
  }
  if (sources.has("transcripts")) {
    tags.push("local transcripts");
  }
  const suffix = tags.length > 0 ? ` · ${tags.join(" · ")}` : "";
  return `Workflow #${workflowId}${suffix}`;
}

/**
 * Discover unfinished workflows from checkout-local Matt Auto state only.
 * Never reads GitHub, never runs preflight, never touches remotes.
 */
export async function listLocalUnfinishedWorkflows(
  workflowRoot: string,
): Promise<readonly LocalUnfinishedWorkflow[]> {
  const byId = new Map<number, Set<LocalUnfinishedWorkflowSource>>();

  const remember = (
    workflowId: number,
    source: LocalUnfinishedWorkflowSource,
  ) => {
    if (!isPositiveInt(workflowId)) return;
    const set = byId.get(workflowId) ?? new Set<LocalUnfinishedWorkflowSource>();
    set.add(source);
    byId.set(workflowId, set);
  };

  const prefs = await readPreferencesFile(workflowRoot);
  for (const value of Object.values(prefs?.activeWorkflowIds ?? {})) {
    if (isPositiveInt(value)) remember(value, "legacy-pointer");
  }
  for (const binding of Object.values(prefs?.workflowHomeBindings ?? {})) {
    if (
      binding &&
      isPositiveInt(binding.workflowId) &&
      isCanonicalTargetIdentity(binding.target)
    ) {
      // Keep only structurally valid bindings; key is ignored for listing.
      void canonicalTargetIdentityKey(binding.target);
      remember(binding.workflowId, "binding");
    }
  }

  for (const workflowId of await listTranscriptWorkflowIds(workflowRoot)) {
    remember(workflowId, "transcripts");
  }

  return [...byId.entries()]
    .sort(([a], [b]) => a - b)
    .map(([workflowId, sources]) => {
      const sourceList = [...sources];
      const bound =
        sources.has("binding") || sources.has("legacy-pointer");
      return {
        workflowId,
        sources: sourceList,
        bound,
        label: formatLocalLabel(workflowId, sources),
      };
    });
}
