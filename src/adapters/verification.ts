import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LocalVerificationResult, VerificationPort } from "../ports.js";

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
      maxBuffer: 8 * 1024 * 1024,
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

      for (const command of commands) {
        const [bin, ...args] = command.split(" ");
        if (!bin) continue;
        const result = await run(worktreePath, bin, args);
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
