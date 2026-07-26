/**
 * Fail-closed gate + dual-root publish for submodule gitlinks (mode 160000).
 *
 * Before parent Integration / Workflow PR merge:
 * 1. Ensure each gitlink SHA is on the submodule remote (push if local-only).
 * 2. Fail closed if a SHA is still unreachable after the push attempt.
 *
 * Prevents parent-only pointer bumps when the submodule commit was never
 * published (matt-skills-ops #30 / dual-root delivery).
 */

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitlinkEntry = {
  path: string;
  sha: string;
};

/** One submodule commit published by Matt Auto before Integration. */
export type SubmodulePublishedEntry = {
  path: string;
  sha: string;
  remote: string;
  /** Remote ref that received the commit (object reachability). */
  ref: string;
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

export type SubmoduleEnsureResult =
  | {
      ok: true;
      checked: readonly GitlinkEntry[];
      /** Commits that were missing on the remote and successfully pushed. */
      published: readonly SubmodulePublishedEntry[];
    }
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
function lsRemoteLineMatchesSha(line: string, sha: string): boolean {
  const remoteSha = line.trim().split(/\s+/)[0]?.toLowerCase();
  if (!remoteSha) return false;
  const want = sha.toLowerCase();
  return (
    remoteSha === want ||
    remoteSha.startsWith(want) ||
    want.startsWith(remoteSha)
  );
}

export async function remoteHasCommit(
  remoteUrl: string,
  sha: string,
  cwd: string,
): Promise<boolean> {
  // 1) Ask for the SHA as a ref name (works when a branch tip equals the SHA).
  const byName = await run(cwd, "git", ["ls-remote", remoteUrl, sha]);
  if (byName.code === 0) {
    for (const line of byName.stdout.split("\n")) {
      if (lsRemoteLineMatchesSha(line, sha)) return true;
    }
  }

  // 2) Scan all advertised tips (covers matt-auto/gitlink/* publish refs).
  const all = await run(cwd, "git", ["ls-remote", remoteUrl]);
  if (all.code === 0) {
    for (const line of all.stdout.split("\n")) {
      if (lsRemoteLineMatchesSha(line, sha)) return true;
    }
  }

  // 3) GitHub often does not advertise non-tip commits via ls-remote.
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
 * Remote ref used to publish a gitlink SHA without rewriting submodule main.
 * Makes the object fetchable for parent clones while keeping delivery dual-root.
 */
export function gitlinkPublishRef(sha: string): string {
  const id = sha.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 12);
  return `refs/heads/matt-auto/gitlink/${id || "unknown"}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the local submodule checkout contains the commit object.
 */
export async function localHasCommit(
  submoduleDir: string,
  sha: string,
): Promise<boolean> {
  const result = await run(submoduleDir, "git", ["cat-file", "-t", sha]);
  return result.code === 0 && result.stdout.trim() === "commit";
}

/**
 * Push a local commit object to the submodule remote so the parent gitlink
 * is fetchable. Uses a dedicated matt-auto/gitlink/* branch (no force to main).
 */
export async function pushSubmoduleCommit(input: {
  submoduleDir: string;
  remoteUrl: string;
  sha: string;
}): Promise<{ ok: true; ref: string } | { ok: false; reason: string }> {
  const { submoduleDir, remoteUrl, sha } = input;
  if (!(await pathExists(submoduleDir))) {
    return {
      ok: false,
      reason: `Submodule checkout missing at ${submoduleDir} — cannot push ${sha}.`,
    };
  }
  if (!(await localHasCommit(submoduleDir, sha))) {
    return {
      ok: false,
      reason: `Submodule checkout at ${submoduleDir} does not contain commit ${sha} — cannot publish the gitlink.`,
    };
  }

  const ref = gitlinkPublishRef(sha);
  const push = await run(submoduleDir, "git", [
    "push",
    remoteUrl,
    `${sha}:${ref}`,
  ]);
  if (push.code !== 0) {
    const detail = (push.stderr || push.stdout || "push failed").trim();
    return {
      ok: false,
      reason: `Failed to push submodule commit ${sha} to ${remoteUrl} (${ref}): ${detail}`,
    };
  }
  return { ok: true, ref };
}

/**
 * Verify every submodule gitlink at HEAD is present on its configured remote.
 * No gitlinks → ok (nothing to check). Does not push.
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

/**
 * Dual-root delivery: for each gitlink at HEAD, push the commit to the
 * submodule remote when it is local-only, then re-verify reachability.
 *
 * Call this before parent Integration push / Workflow PR merge.
 */
export async function ensureSubmoduleGitlinksPublished(
  worktreePath: string,
): Promise<SubmoduleEnsureResult> {
  const gitlinks = await listGitlinksAtHead(worktreePath);
  if (gitlinks.length === 0) {
    return { ok: true, checked: [], published: [] };
  }

  const checked: GitlinkEntry[] = [];
  const published: SubmodulePublishedEntry[] = [];

  for (const link of gitlinks) {
    const remote = await resolveSubmoduleRemoteUrl(worktreePath, link.path);
    if (!remote) {
      return {
        ok: false,
        reason: `Submodule "${link.path}" records SHA ${link.sha} but no remote URL was found in .gitmodules — cannot publish or verify the commit.`,
        path: link.path,
        sha: link.sha,
      };
    }

    let present = await remoteHasCommit(remote, link.sha, worktreePath);
    if (!present) {
      const submoduleDir = path.join(worktreePath, link.path);
      const push = await pushSubmoduleCommit({
        submoduleDir,
        remoteUrl: remote,
        sha: link.sha,
      });
      if (!push.ok) {
        return {
          ok: false,
          reason: push.reason,
          path: link.path,
          sha: link.sha,
          remote,
        };
      }
      present = await remoteHasCommit(remote, link.sha, worktreePath);
      if (!present) {
        return {
          ok: false,
          reason: `Pushed submodule "${link.path}" commit ${link.sha} to ${remote} (${push.ref}) but the remote still does not advertise it — re-check credentials or try again.`,
          path: link.path,
          sha: link.sha,
          remote,
        };
      }
      published.push({
        path: link.path,
        sha: link.sha,
        remote,
        ref: push.ref,
      });
    }

    checked.push(link);
  }

  return { ok: true, checked, published };
}
