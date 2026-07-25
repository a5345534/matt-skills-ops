import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CreateSpecSkillOutcome,
  CreateTicketsSkillOutcome,
  PrepareImplementOutcome,
  SkillsPort,
} from "../ports.js";

/**
 * Optional host that performs Create-spec / Create-tickets skill invocation.
 * The adapter discovers installed skills and delegates invocation without
 * modifying skill definitions. When omitted, run methods fail closed.
 *
 * `prepareImplement` is optional; the adapter can build a default `/implement`
 * prompt when the skill is installed.
 */
export type SkillsHost = {
  runCreateSpec?(): Promise<CreateSpecSkillOutcome>;
  runCreateTickets?(input: {
    workflowId: number;
    title?: string;
  }): Promise<CreateTicketsSkillOutcome>;
  prepareImplement?(input: {
    ticketNumber: number;
    title: string;
  }): Promise<PrepareImplementOutcome>;
  prepareResolveConflicts?(input: {
    ticketNumber: number;
    ticketBranch: string;
    integrationBranch: string;
  }): Promise<PrepareImplementOutcome>;
};

/** @deprecated Prefer SkillsHost; kept for existing Create-spec wiring. */
export type CreateSpecHost = {
  runCreateSpec(): Promise<CreateSpecSkillOutcome>;
};

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function readSkillName(skillDir: string): Promise<string | undefined> {
  try {
    const skillMd = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
    if (match?.[1]) {
      const nameLine = /^name:\s*(.+)$/m.exec(match[1]);
      if (nameLine?.[1]) {
        return nameLine[1].trim().replace(/^["']|["']$/g, "");
      }
    }
    return path.basename(skillDir);
  } catch {
    return undefined;
  }
}

async function collectFromRoot(root: string, names: Set<string>): Promise<void> {
  if (!(await isDirectory(root))) return;

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(root, entry);
    if (!(await isDirectory(full))) continue;
    const name = await readSkillName(full);
    if (name) names.add(name);
  }
}

function skillSearchRoots(cwd: string): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".pi", "agent", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(cwd, ".pi", "skills"),
    path.join(cwd, ".agents", "skills"),
  ];
}

/**
 * Discover installed skill names and invoke Planning skills via an optional host.
 * Does not parse skill bodies for orchestration logic and never modifies SKILL.md.
 */
const skillNameCache = new Map<
  string,
  { names: readonly string[]; at: number }
>();
const SKILL_NAME_TTL_MS = 60_000;

export function createSkillsPort(
  cwd: string,
  host?: SkillsHost | CreateSpecHost,
): SkillsPort {
  async function installedSkillNames(): Promise<readonly string[]> {
    const cached = skillNameCache.get(cwd);
    if (cached && Date.now() - cached.at < SKILL_NAME_TTL_MS) {
      return cached.names;
    }
    const names = new Set<string>();
    for (const root of skillSearchRoots(cwd)) {
      await collectFromRoot(root, names);
    }
    const sorted = [...names].sort();
    skillNameCache.set(cwd, { names: sorted, at: Date.now() });
    return sorted;
  }

  return {
    installedSkillNames,

    async runCreateSpec() {
      const names = await installedSkillNames();
      if (!names.includes("to-spec")) {
        return {
          ok: false,
          reason:
            "Installed skill to-spec is missing. Install it into a Pi skill location and retry Create-spec.",
        };
      }

      if (!host || !("runCreateSpec" in host) || !host.runCreateSpec) {
        return {
          ok: false,
          reason:
            "Create-spec Planning host is not wired. Matt Auto cannot invoke to-spec without a Workflow-home host.",
        };
      }

      // Host invokes the installed skill capability; definitions stay untouched.
      return host.runCreateSpec();
    },

    async runCreateTickets(input) {
      const names = await installedSkillNames();
      if (!names.includes("to-tickets")) {
        return {
          ok: false,
          reason:
            "Installed skill to-tickets is missing. Install it into a Pi skill location and retry Create-tickets.",
        };
      }

      const ticketsHost = host as SkillsHost | undefined;
      if (!ticketsHost?.runCreateTickets) {
        return {
          ok: false,
          reason:
            "Create-tickets Planning host is not wired. Matt Auto cannot invoke to-tickets without a Workflow-home host.",
        };
      }

      // Host invokes the installed skill capability; definitions stay untouched.
      return ticketsHost.runCreateTickets(input);
    },

    async prepareImplement(input) {
      const names = await installedSkillNames();
      if (!names.includes("implement")) {
        return {
          ok: false,
          reason:
            "Installed skill implement is missing. Install it into a Pi skill location and retry Implementation.",
        };
      }

      const implementHost = host as SkillsHost | undefined;
      if (implementHost?.prepareImplement) {
        // Host may customize the worker prompt; skill definitions stay untouched.
        return implementHost.prepareImplement(input);
      }

      // Default orchestration wrapper: run /implement for the ticket in the worker.
      return {
        ok: true,
        skillCommand: "/implement",
        prompt: [
          `/implement`,
          "",
          `Implement GitHub issue #${input.ticketNumber}: ${input.title}`,
          "",
          "Work only in this Implementation workspace. Commit locally when done.",
          "Do not push, edit GitHub issues, or mutate remote workflow state.",
          "",
          "## Matt Auto Stage result (required)",
          "When finished, print a single JSON object (optionally in a ```json fence) so the coordinator can continue:",
          "",
          "```json",
          '{',
          '  "type": "stage-result",',
          '  "outcome": {',
          '    "status": "completed",',
          '    "summary": "<one-line summary of what was committed>",',
          '    "localCommitSha": "<git rev-parse HEAD if available>"',
          "  }",
          "}",
          "```",
          "",
          'On failure use "status": "failed" and a "reason" string instead.',
          "Do not exit successfully without this Stage result object.",
        ].join("\n"),
      };
    },

    async prepareResolveConflicts(input) {
      const names = await installedSkillNames();
      if (!names.includes("resolving-merge-conflicts")) {
        return {
          ok: false,
          reason:
            "Installed skill resolving-merge-conflicts is missing. Install it into a Pi skill location and retry Conflict resolution.",
        };
      }

      const conflictHost = host as SkillsHost | undefined;
      if (conflictHost?.prepareResolveConflicts) {
        return conflictHost.prepareResolveConflicts(input);
      }

      return {
        ok: true,
        skillCommand: "/resolving-merge-conflicts",
        prompt: [
          `/resolving-merge-conflicts`,
          "",
          `Resolve the in-progress merge conflict integrating ticket #${input.ticketNumber}.`,
          `Ticket branch: ${input.ticketBranch}`,
          `Integration branch: ${input.integrationBranch}`,
          "",
          "Work only in this Integration workspace. Always resolve; never --abort.",
          "Do not push, edit GitHub issues, or mutate remote workflow state.",
          "",
          "## Matt Auto Stage result (required)",
          "When finished, print a single JSON object (optionally in a ```json fence):",
          "```json",
          '{ "type": "stage-result", "outcome": { "status": "completed", "summary": "merge conflict resolved" } }',
          "```",
        ].join("\n"),
      };
    },
  };
}
