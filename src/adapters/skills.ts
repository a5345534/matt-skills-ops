import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SkillsPort } from "../ports.js";

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
 * Discover installed skill names from standard Pi / agents skill locations.
 * Does not parse skill bodies for orchestration logic.
 */
export function createSkillsPort(cwd: string): SkillsPort {
  return {
    async installedSkillNames() {
      const names = new Set<string>();
      for (const root of skillSearchRoots(cwd)) {
        await collectFromRoot(root, names);
      }
      return [...names].sort();
    },
  };
}
