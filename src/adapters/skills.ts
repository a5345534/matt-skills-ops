import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CreateSpecSkillOutcome,
  CreateTicketsSkillOutcome,
  SkillsPort,
} from "../ports.js";

/**
 * Optional host that performs Create-spec / Create-tickets skill invocation.
 * The adapter discovers installed skills and delegates invocation without
 * modifying skill definitions. When omitted, run methods fail closed.
 */
export type SkillsHost = {
  runCreateSpec?(): Promise<CreateSpecSkillOutcome>;
  runCreateTickets?(input: {
    workflowId: number;
    title?: string;
  }): Promise<CreateTicketsSkillOutcome>;
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
export function createSkillsPort(
  cwd: string,
  host?: SkillsHost | CreateSpecHost,
): SkillsPort {
  async function installedSkillNames(): Promise<readonly string[]> {
    const names = new Set<string>();
    for (const root of skillSearchRoots(cwd)) {
      await collectFromRoot(root, names);
    }
    return [...names].sort();
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
  };
}
