import { execFile } from "node:child_process";
import { access, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LocalVerificationResult, VerificationPort } from "../ports.js";

const execFileAsync = promisify(execFile);

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Primary package root for a git worktree (directory containing node_modules). */
export async function resolvePrimaryPackageRoot(
  worktreePath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: worktreePath, encoding: "utf8" },
    );
    const commonDir = stdout.trim();
    if (!commonDir) return undefined;
    // common-dir is …/repo/.git; package root is parent of that directory.
    return path.dirname(commonDir);
  } catch {
    return undefined;
  }
}

/**
 * Worktrees created with `git worktree add` do not get node_modules.
 * Symlink the primary checkout's node_modules when missing so `tsc` / vitest
 * resolve packages the same way as Workflow home.
 */
export async function ensureWorktreeNodeModules(
  worktreePath: string,
): Promise<void> {
  const localNm = path.join(worktreePath, "node_modules");
  if (await pathExists(localNm)) return;
  const primary = await resolvePrimaryPackageRoot(worktreePath);
  if (!primary || path.resolve(primary) === path.resolve(worktreePath)) return;
  const primaryNm = path.join(primary, "node_modules");
  if (!(await pathExists(primaryNm))) return;
  try {
    await symlink(primaryNm, localNm, "dir");
  } catch {
    // Race or platform limits — PATH fallback may still help for binaries only.
  }
}

/**
 * Prefer the worktree's .bin, then the primary checkout's .bin (git common dir).
 */
export async function resolveNodeBinPathPrefix(
  worktreePath: string,
): Promise<string> {
  const bins: string[] = [];
  const localBin = path.join(worktreePath, "node_modules", ".bin");
  if (await pathExists(localBin)) bins.push(localBin);

  const primary = await resolvePrimaryPackageRoot(worktreePath);
  if (primary) {
    const primaryBin = path.join(primary, "node_modules", ".bin");
    if (
      primaryBin !== localBin &&
      (await pathExists(primaryBin)) &&
      !bins.includes(primaryBin)
    ) {
      bins.push(primaryBin);
    }
  }

  return bins.join(path.delimiter);
}

async function run(
  cwd: string,
  command: string,
  args: string[],
  pathPrefix: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  if (pathPrefix) {
    env.PATH = env.PATH ? `${pathPrefix}${path.delimiter}${env.PATH}` : pathPrefix;
  }
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env,
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

type PackageScripts = Record<string, string | undefined>;

async function readPackageScripts(
  worktreePath: string,
): Promise<PackageScripts | undefined> {
  try {
    const raw = await readFile(path.join(worktreePath, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: PackageScripts };
    return parsed.scripts ?? {};
  } catch {
    return undefined;
  }
}

/**
 * Discover project-local check commands in a worktree.
 * Prefers package.json scripts: typecheck, then test.
 */
export function discoverLocalVerificationCommands(
  scripts: PackageScripts | undefined,
): string[] {
  if (!scripts) return [];
  const commands: string[] = [];
  if (typeof scripts.typecheck === "string" && scripts.typecheck.trim()) {
    commands.push("npm run typecheck");
  }
  if (typeof scripts.test === "string" && scripts.test.trim()) {
    commands.push("npm test");
  }
  return commands;
}

/**
 * Project-discoverable Local verification for the Integration workspace.
 * Empty discovery succeeds (nothing to fail). Command failure fails closed.
 */
export function createVerificationPort(): VerificationPort {
  return {
    async runLocalVerification(worktreePath): Promise<LocalVerificationResult> {
      const scripts = await readPackageScripts(worktreePath);
      const commands = discoverLocalVerificationCommands(scripts);

      if (commands.length === 0) {
        return { ok: true, commands: [] };
      }

      // Integration/Implementation worktrees rarely copy node_modules.
      await ensureWorktreeNodeModules(worktreePath);
      const pathPrefix = await resolveNodeBinPathPrefix(worktreePath);

      for (const command of commands) {
        const [bin, ...args] = command.split(" ");
        if (!bin) continue;
        const result = await run(worktreePath, bin, args, pathPrefix);
        if (result.code !== 0) {
          const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim();
          return {
            ok: false,
            reason: `${command} failed: ${detail}`,
            commands,
          };
        }
      }

      return { ok: true, commands };
    },
  };
}
