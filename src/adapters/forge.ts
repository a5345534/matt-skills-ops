import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Per-workflow-root, uncommitted Forge configuration. */
export const FORGE_CONFIG_RELATIVE_PATH = path.join(
  ".pi",
  "matt-auto",
  "forge.json",
);

export type ForgeProvider = "github" | "forgejo";

/**
 * Public, non-secret connection facts for the local Forgejo instance that owns
 * a Workflow root. API credentials are resolved separately and never enter a
 * manifest, log payload, or canonical repository identity.
 */
export type ForgejoConnection = {
  provider: "forgejo";
  baseUrl: string;
  owner: string;
  name: string;
  remoteName: string;
  tokenEnv: string;
  tokenFile?: string;
};

export type ForgeResolution =
  | { provider: "github" }
  | { provider: "forgejo"; connection: ForgejoConnection }
  | { provider: "unsupported"; reason: string };

type ForgeConfigFile = {
  provider?: unknown;
  baseUrl?: unknown;
  owner?: unknown;
  name?: unknown;
  remote?: unknown;
  tokenEnv?: unknown;
  tokenFile?: unknown;
};

type ParsedRemote = {
  owner: string;
  name: string;
  host: string;
  /** Present only for HTTP(S) remotes, including a Forgejo subpath when used. */
  inferredBaseUrl?: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normaliseBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function remotePathParts(value: string): string[] | undefined {
  const normalized = value.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const owner = parts.at(-2);
  const name = parts.at(-1);
  if (!owner || !name) return undefined;
  return parts;
}

/**
 * Parse an HTTP(S), SSH URL, or scp-like Git remote into its owner/name path.
 * Exported for provider-resolution tests; it never inspects credentials.
 */
export function parseGitRemoteUrl(remoteUrl: string): ParsedRemote | undefined {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed);
    const parts = remotePathParts(url.pathname);
    if (!parts) return undefined;
    const owner = parts.at(-2)!;
    const name = parts.at(-1)!;
    const host = url.hostname.toLowerCase();
    if (url.protocol === "http:" || url.protocol === "https:") {
      const prefix = parts.slice(0, -2).join("/");
      const base = new URL(url.origin);
      base.pathname = prefix ? `/${prefix}` : "";
      const inferredBaseUrl = normaliseBaseUrl(base.toString());
      return {
        owner,
        name,
        host,
        ...(inferredBaseUrl ? { inferredBaseUrl } : {}),
      };
    }
    return { owner, name, host };
  } catch {
    // scp-like syntax: git@host:owner/repository.git
    const match = /^(?:[^@\s]+@)?([^:\s/]+):(.+)$/.exec(trimmed);
    if (!match?.[1] || !match[2]) return undefined;
    const parts = remotePathParts(match[2]);
    if (!parts) return undefined;
    return {
      owner: parts.at(-2)!,
      name: parts.at(-1)!,
      host: match[1].toLowerCase(),
    };
  }
}

function isGitHubHost(host: string): boolean {
  return host === "github.com" || host === "ssh.github.com";
}

async function remoteUrlFor(
  cwd: string,
  remoteName: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", [
      "config",
      "--get",
      `remote.${remoteName}.url`,
    ], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    const value = (stdout ?? "").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function readForgeConfig(cwd: string): Promise<ForgeConfigFile | undefined> {
  try {
    const raw = await readFile(path.join(cwd, FORGE_CONFIG_RELATIVE_PATH), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ForgeConfigFile)
      : undefined;
  } catch {
    return undefined;
  }
}

function forgejoConnectionFrom(
  cwd: string,
  config: ForgeConfigFile,
  remoteName: string,
  remoteUrl: string | undefined,
): ForgeResolution {
  if (config.provider !== "forgejo") {
    return {
      provider: "unsupported",
      reason: `Unsupported Forge provider ${JSON.stringify(config.provider)} in ${FORGE_CONFIG_RELATIVE_PATH}.`,
    };
  }
  if (!isNonEmptyString(config.baseUrl)) {
    return {
      provider: "unsupported",
      reason: `Forgejo configuration ${FORGE_CONFIG_RELATIVE_PATH} needs a non-empty baseUrl.`,
    };
  }
  const baseUrl = normaliseBaseUrl(config.baseUrl);
  if (!baseUrl) {
    return {
      provider: "unsupported",
      reason: `Forgejo baseUrl in ${FORGE_CONFIG_RELATIVE_PATH} must be an http(s) URL.`,
    };
  }

  const parsedRemote = remoteUrl ? parseGitRemoteUrl(remoteUrl) : undefined;
  const owner = isNonEmptyString(config.owner)
    ? config.owner.trim()
    : parsedRemote?.owner;
  const name = isNonEmptyString(config.name)
    ? config.name.trim()
    : parsedRemote?.name;
  if (!owner || !name) {
    return {
      provider: "unsupported",
      reason: `Forgejo configuration needs owner/name or a parseable ${remoteName} remote URL.`,
    };
  }
  if (
    parsedRemote &&
    ((isNonEmptyString(config.owner) && parsedRemote.owner !== owner) ||
      (isNonEmptyString(config.name) && parsedRemote.name !== name))
  ) {
    return {
      provider: "unsupported",
      reason: `Forgejo configuration owner/name does not match remote ${remoteName}.`,
    };
  }
  if (
    parsedRemote?.inferredBaseUrl &&
    parsedRemote.inferredBaseUrl !== baseUrl
  ) {
    return {
      provider: "unsupported",
      reason: `Forgejo baseUrl ${baseUrl} does not match remote ${remoteName} (${parsedRemote.inferredBaseUrl}).`,
    };
  }

  const tokenEnv = isNonEmptyString(config.tokenEnv)
    ? config.tokenEnv.trim()
    : "MATT_AUTO_FORGEJO_TOKEN";
  const tokenFile = isNonEmptyString(config.tokenFile)
    ? path.resolve(cwd, config.tokenFile.trim())
    : undefined;
  return {
    provider: "forgejo",
    connection: {
      provider: "forgejo",
      baseUrl,
      owner,
      name,
      remoteName,
      tokenEnv,
      ...(tokenFile ? { tokenFile } : {}),
    },
  };
}

/**
 * Resolve this Workflow root's currently selected forge.
 *
 * GitHub remains the implicit legacy provider while #53 is being completed.
 * Forgejo is opt-in through the ignored root configuration so arbitrary Git
 * hosts never become partially-supported trackers by accident.
 */
export async function resolveForge(cwd: string): Promise<ForgeResolution> {
  const config = await readForgeConfig(cwd);
  const remoteName = isNonEmptyString(config?.remote)
    ? config.remote.trim()
    : "origin";
  if (!/^[A-Za-z0-9._-]+$/.test(remoteName)) {
    return {
      provider: "unsupported",
      reason: `Forge remote name ${JSON.stringify(remoteName)} is invalid.`,
    };
  }
  const remoteUrl = await remoteUrlFor(cwd, remoteName);

  if (config) {
    return forgejoConnectionFrom(cwd, config, remoteName, remoteUrl);
  }

  const parsedRemote = remoteUrl ? parseGitRemoteUrl(remoteUrl) : undefined;
  if (parsedRemote && isGitHubHost(parsedRemote.host)) {
    return { provider: "github" };
  }
  return {
    provider: "unsupported",
    reason:
      "No supported forge configuration was found. Use a GitHub origin or add .pi/matt-auto/forge.json for Forgejo.",
  };
}

/** Cache provider discovery briefly within one adapter instance. */
export function createForgeResolver(cwd: string): () => Promise<ForgeResolution> {
  let cached: { at: number; result: ForgeResolution } | undefined;
  return async () => {
    if (cached && Date.now() - cached.at < 5_000) return cached.result;
    const result = await resolveForge(cwd);
    cached = { at: Date.now(), result };
    return result;
  };
}

/** Read a Forgejo API token without exposing it through connection metadata. */
export async function resolveForgejoToken(
  connection: ForgejoConnection,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const fromEnvironment = environment[connection.tokenEnv]?.trim();
  if (fromEnvironment) return fromEnvironment;
  if (!connection.tokenFile) return undefined;
  try {
    const fromFile = (await readFile(connection.tokenFile, "utf8")).trim();
    return fromFile || undefined;
  } catch {
    return undefined;
  }
}
