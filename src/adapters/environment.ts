import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EnvironmentPort } from "../ports.js";

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

/**
 * Real EnvironmentPort backed by git and gh in a Workflow root.
 * Does not create remotes, authenticate, or invent branches.
 */
// Process-level caches so every /matt-auto open does not re-hit network.
const ghAuthCache = new Map<string, { ok: boolean; at: number }>();
const GH_AUTH_TTL_MS = 60_000;

export function createEnvironmentPort(cwd: string): EnvironmentPort {
  return {
    async hasGitHubRemote() {
      const result = await run(cwd, "git", ["remote", "-v"]);
      if (result.code !== 0) return false;
      return /github\.com[:/]/i.test(result.stdout);
    },

    async isGhAuthenticated() {
      const cached = ghAuthCache.get(cwd);
      if (cached && Date.now() - cached.at < GH_AUTH_TTL_MS) {
        return cached.ok;
      }
      const result = await run(cwd, "gh", ["auth", "status"]);
      const ok = result.code === 0;
      ghAuthCache.set(cwd, { ok, at: Date.now() });
      return ok;
    },

    async targetBranchExists(branch: string) {
      const local = await run(cwd, "git", [
        "rev-parse",
        "--verify",
        "--quiet",
        branch,
      ]);
      if (local.code === 0) return true;

      const remoteRef = await run(cwd, "git", [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${branch}`,
      ]);
      if (remoteRef.code === 0) return true;

      // Avoid git ls-remote (network) on every menu open. If the branch is not
      // known locally, treat it as missing and let the user fetch/create it.
      return false;
    },
  };
}

/** Resolve the nearest enclosing Git repository root, or cwd if not in a repo. */
export async function resolveGitRoot(cwd: string): Promise<string> {
  const result = await run(cwd, "git", ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return cwd;
  return result.stdout.trim() || cwd;
}
