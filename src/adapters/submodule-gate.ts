/**
 * Fail-closed gate: submodule gitlinks (mode 160000) recorded in a worktree
 * must point at commits that exist on the submodule's configured remote.
 *
 * Prevents parent-only pointer bumps from integrating when the submodule
 * commit was never pushed (matt-skills-ops #30).
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitlinkEntry = {
  path: string;
  sha: string;
};

export type SubmoduleGateResult =
  | { ok: true; checked: readonly GitlinkEntry[] }
  | {
      ok: false;
      reason: string;
      path?: string;
      sha?: string;
      remote?: string;
    };

async function run(
  cwd: string,
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    const err = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
    };
  }
}

/**
 * List gitlink entries (submodule mode 160000) at HEAD of a worktree.
 */
export async function listGitlinksAtHead(
  worktreePath: string,
): Promise<GitlinkEntry[]> {
  const result = await run(worktreePath, "git", [
    "ls-tree",
    "-r",
    "HEAD",
  ]);
  if (result.code !== 0) return [];

  const entries: GitlinkEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    // 160000 commit <sha>\t<path>
    const match = /^160000\s+commit\s+([0-9a-f]{7,40})\t(.+)$/i.exec(
      line.trim(),
    );
    if (!match?.[1] || !match[2]) continue;
    entries.push({ sha: match[1], path: match[2] });
  }
  return entries;
}

/**
 * Resolve submodule remote URL from .gitmodules for a path.
 */
export async function resolveSubmoduleRemoteUrl(
  worktreePath: string,
  submodulePath: string,
): Promise<string | undefined> {
  const normalized = submodulePath.replace(/\\/g, "/").replace(/\/$/, "");

  // Prefer git config from .gitmodules
  const viaGit = await run(worktreePath, "git", [
    "config",
    "-f",
    ".gitmodules",
    "--get-regexp",
    String.raw`^submodule\..*\.path$`,
  ]);
  if (viaGit.code === 0) {
    for (const line of viaGit.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const key = parts[0]!;
      const pathValue = parts.slice(1).join(" ").replace(/\\/g, "/");
      if (pathValue !== normalized) continue;
      const nameMatch = /^submodule\.(.+)\.path$/.exec(key);
      if (!nameMatch?.[1]) continue;
      const urlResult = await run(worktreePath, "git", [
        "config",
        "-f",
        ".gitmodules",
        "--get",
        `submodule.${nameMatch[1]}.url`,
      ]);
      if (urlResult.code === 0 && urlResult.stdout.trim()) {
        return urlResult.stdout.trim();
      }
    }
  }

  // Fallback: parse .gitmodules manually
  try {
    const raw = await readFile(
      path.join(worktreePath, ".gitmodules"),
      "utf8",
    );
    const sections = raw.split(/^\s*\[submodule\s+"/m).slice(1);
    for (const section of sections) {
      const pathMatch = /^\s*path\s*=\s*(.+)$/m.exec(section);
      const urlMatch = /^\s*url\s*=\s*(.+)$/m.exec(section);
      const p = pathMatch?.[1]?.trim().replace(/\\/g, "/");
      const url = urlMatch?.[1]?.trim();
      if (p === normalized && url) return url;
    }
  } catch {
    // no .gitmodules
  }
  return undefined;
}

/**
 * True when the remote advertises the commit object (or a ref that resolves to it).
 * Uses `git ls-remote <url> <sha>` which works for full SHAs on GitHub and most hosts.
 */
export async function remoteHasCommit(
  remoteUrl: string,
  sha: string,
  cwd: string,
): Promise<boolean> {
  const fullSha = sha.length >= 40 ? sha : sha;
  const result = await run(cwd, "git", ["ls-remote", remoteUrl, fullSha]);
  if (result.code !== 0) {
    // Fallback: try without explicit ref filter (slower; last resort)
    const all = await run(cwd, "git", ["ls-remote", remoteUrl]);
    if (all.code !== 0) return false;
    return all.stdout.toLowerCase().includes(sha.toLowerCase());
  }
  // ls-remote prints "<sha>\t<ref>" when the object is known as a ref tip;
  // for bare commit SHAs on GitHub, a matching first-column SHA means found.
  for (const line of result.stdout.split("\n")) {
    const remoteSha = line.trim().split(/\s+/)[0]?.toLowerCase();
    if (!remoteSha) continue;
    if (
      remoteSha === sha.toLowerCase() ||
      remoteSha.startsWith(sha.toLowerCase()) ||
      sha.toLowerCase().startsWith(remoteSha)
    ) {
      return true;
    }
  }

  // GitHub often does not advertise arbitrary commits via ls-remote.
  // Fall back to GitHub REST when the remote is a github.com URL.
  const gh = parseGithubRepo(remoteUrl);
  if (gh) {
    const api = await run(cwd, "gh", [
      "api",
      `repos/${gh.owner}/${gh.name}/commits/${sha}`,
      "--jq",
      ".sha",
    ]);
    if (api.code === 0 && api.stdout.trim().length >= 7) {
      return true;
    }
    return false;
  }

  return false;
}

/** Parse github.com owner/name from common remote URL forms. */
export function parseGithubRepo(
  remoteUrl: string,
): { owner: string; name: string } | undefined {
  const patterns = [
    /github\.com[:/](?<owner>[^/]+)\/(?<name>[^/.]+?)(?:\.git)?$/i,
    /^git@github\.com:(?<owner>[^/]+)\/(?<name>[^/.]+?)(?:\.git)?$/i,
  ];
  for (const re of patterns) {
    const m = re.exec(remoteUrl.trim());
    if (m?.groups?.owner && m.groups.name) {
      return { owner: m.groups.owner, name: m.groups.name };
    }
  }
  return undefined;
}

/**
 * Verify every submodule gitlink at HEAD is present on its configured remote.
 * No gitlinks → ok (nothing to check).
 */
export async function verifySubmoduleGitlinksReachable(
  worktreePath: string,
): Promise<SubmoduleGateResult> {
  const gitlinks = await listGitlinksAtHead(worktreePath);
  if (gitlinks.length === 0) {
    return { ok: true, checked: [] };
  }

  const checked: GitlinkEntry[] = [];
  for (const link of gitlinks) {
    const remote = await resolveSubmoduleRemoteUrl(worktreePath, link.path);
    if (!remote) {
      return {
        ok: false,
        reason: `Submodule "${link.path}" records SHA ${link.sha} but no remote URL was found in .gitmodules — cannot verify the commit was published.`,
        path: link.path,
        sha: link.sha,
      };
    }
    const present = await remoteHasCommit(remote, link.sha, worktreePath);
    if (!present) {
      return {
        ok: false,
        reason: `Submodule "${link.path}" records SHA ${link.sha} which is not present on ${remote} — push the submodule first.`,
        path: link.path,
        sha: link.sha,
        remote,
      };
    }
    checked.push(link);
  }
  return { ok: true, checked };
}
