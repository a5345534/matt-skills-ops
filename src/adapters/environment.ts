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
      return branchExistsLocallyOrOrigin(cwd, branch);
    },

    async detectDefaultBranch() {
      return detectDefaultBranchName(cwd);
    },
  };
}

async function branchExistsLocallyOrOrigin(
  cwd: string,
  branch: string,
): Promise<boolean> {
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
}

/** Common default branch names, preferred order when origin/HEAD is missing. */
export const COMMON_DEFAULT_BRANCH_CANDIDATES = [
  "main",
  "master",
  "trunk",
  "develop",
] as const;

/**
 * Detect the repo's primary branch without preferences:
 * 1) symbolic-ref origin/HEAD (e.g. refs/remotes/origin/master)
 * 2) first common name that exists locally or as origin/*
 */
export async function detectDefaultBranchName(
  cwd: string,
): Promise<string | undefined> {
  const sym = await run(cwd, "git", [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  if (sym.code === 0) {
    const ref = sym.stdout.trim();
    // refs/remotes/origin/main  or  origin/main
    const match =
      /^refs\/remotes\/origin\/(.+)$/.exec(ref) ??
      /^origin\/(.+)$/.exec(ref);
    if (match?.[1] && match[1].length > 0) {
      return match[1];
    }
  }

  for (const name of COMMON_DEFAULT_BRANCH_CANDIDATES) {
    if (await branchExistsLocallyOrOrigin(cwd, name)) {
      return name;
    }
  }
  return undefined;
}

/** Resolve the nearest enclosing Git repository root, or cwd if not in a repo. */
export async function resolveGitRoot(cwd: string): Promise<string> {
  const result = await run(cwd, "git", ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return cwd;
  return result.stdout.trim() || cwd;
}
