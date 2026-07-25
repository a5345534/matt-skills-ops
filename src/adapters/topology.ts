import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { GitTopologyPort, NestedGitRepository } from "../ports.js";

const execFileAsync = promisify(execFile);

async function run(
  cwd: string,
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    const err = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk parentRoot for nested `.git` markers (directory or file).
 * Skips the parent root itself and common heavy/irrelevant directories.
 */
async function findNestedGitMarkers(parentRoot: string): Promise<string[]> {
  const skipDirNames = new Set([
    ".git",
    "node_modules",
    ".pi",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    ".cache",
  ]);
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skipDirNames.has(entry.name)) continue;

      const full = path.join(dir, entry.name);
      const gitMarker = path.join(full, ".git");
      if (await pathExists(gitMarker)) {
        found.push(full);
        // Nested repos are their own roots; do not walk inside them.
        continue;
      }
      await walk(full);
    }
  }

  await walk(parentRoot);
  return found;
}

async function submodulePaths(parentRoot: string): Promise<Set<string>> {
  const paths = new Set<string>();
  const result = await run(parentRoot, "git", [
    "config",
    "-f",
    ".gitmodules",
    "--get-regexp",
    String.raw`^submodule\..*\.path$`,
  ]);
  if (result.code !== 0) return paths;

  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: submodule.<name>.path <relative-path>
    const space = trimmed.indexOf(" ");
    const relative = space === -1 ? "" : trimmed.slice(space + 1).trim();
    if (!relative) continue;
    paths.add(path.resolve(parentRoot, relative));
  }
  return paths;
}

/**
 * Real GitTopologyPort backed by git and filesystem walks.
 * Returns topology facts only; product filtering stays in the coordinator.
 */
export function createGitTopologyPort(): GitTopologyPort {
  return {
    async nearestGitRoot(startPath: string) {
      const result = await run(startPath, "git", ["rev-parse", "--show-toplevel"]);
      if (result.code !== 0) return undefined;
      const root = result.stdout.trim();
      return root ? path.resolve(root) : undefined;
    },

    async nestedGitRepositories(parentRoot: string) {
      const resolvedParent = path.resolve(parentRoot);
      if (!(await isDirectory(resolvedParent))) return [];

      const [nestedRoots, submodules] = await Promise.all([
        findNestedGitMarkers(resolvedParent),
        submodulePaths(resolvedParent),
      ]);

      const repos: NestedGitRepository[] = nestedRoots.map((nestedPath) => {
        const resolved = path.resolve(nestedPath);
        return {
          path: resolved,
          isSubmodule: submodules.has(resolved),
        };
      });

      // Also surface submodule paths that may not have been walked (sparse / missing).
      for (const submodulePath of submodules) {
        if (repos.some((repo) => repo.path === submodulePath)) continue;
        if (!(await pathExists(path.join(submodulePath, ".git")))) continue;
        repos.push({ path: submodulePath, isSubmodule: true });
      }

      return repos.sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}
