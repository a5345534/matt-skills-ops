import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkflowHomeLockPort } from "../ports.js";
import type { WorkflowHomeLock } from "../types.js";

const LOCK_DIRECTORY = "workflow-home.lock";
const LOCK_RECORD = "owner.json";
const LOCK_SCHEMA = "matt-auto/workflow-home-lock";
const LOCK_VERSION = 1;
const DEFAULT_STALE_AFTER_MS = 2 * 60_000;

type StoredLock = WorkflowHomeLock & {
  schema: typeof LOCK_SCHEMA;
  version: typeof LOCK_VERSION;
  hostname: string;
  pid: number;
  heartbeatAt: string;
};

export type WorkflowHomeLockPortOptions = {
  /** Injected clock for deterministic tests. */
  now?: () => Date;
  /** A lock from a different/dead host is reclaimable after this duration. */
  staleAfterMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return false;
  }
  return new Date(Date.parse(value)).toISOString() === value;
}

function parseStoredLock(value: unknown): StoredLock | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.schema !== LOCK_SCHEMA ||
    value.version !== LOCK_VERSION ||
    !isNonEmptyString(value.holderId) ||
    !isNonEmptyString(value.token) ||
    !isIsoInstant(value.acquiredAt) ||
    !isIsoInstant(value.heartbeatAt) ||
    !isNonEmptyString(value.hostname) ||
    !isPositiveInteger(value.pid)
  ) {
    return undefined;
  }
  return {
    schema: LOCK_SCHEMA,
    version: LOCK_VERSION,
    holderId: value.holderId,
    token: value.token,
    acquiredAt: value.acquiredAt,
    heartbeatAt: value.heartbeatAt,
    hostname: value.hostname,
    pid: value.pid,
  };
}

function copyLock(lock: WorkflowHomeLock): WorkflowHomeLock {
  return {
    holderId: lock.holderId,
    token: lock.token,
    acquiredAt: lock.acquiredAt,
  };
}

function sameLock(left: WorkflowHomeLock, right: WorkflowHomeLock): boolean {
  return (
    left.holderId === right.holderId &&
    left.token === right.token &&
    left.acquiredAt === right.acquiredAt
  );
}

function checkedNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Workflow-home lock clock returned an invalid Date.");
  }
  return new Date(value.getTime());
}

function lockFromStored(stored: StoredLock): WorkflowHomeLock {
  return {
    holderId: stored.holderId,
    token: stored.token,
    acquiredAt: stored.acquiredAt,
  };
}

function processIsAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means another user owns a live process. Unknown errors fail closed.
    return undefined;
  }
}

function lockDirectory(workflowRoot: string): string {
  return path.join(path.resolve(workflowRoot), ".pi", "matt-auto", LOCK_DIRECTORY);
}

/**
 * File-system Workflow-home ownership guard. `mkdir` gives each checkout one
 * atomic owner directory; stale locks are reclaimed only after a dead local
 * pid or a conservative heartbeat timeout. This is deliberately local-only:
 * remote coordination leases still fence different machines/checkouts.
 */
export function createWorkflowHomeLockPort(
  workflowRoot: string,
  options: WorkflowHomeLockPortOptions = {},
): WorkflowHomeLockPort {
  const directory = lockDirectory(workflowRoot);
  const recordPath = path.join(directory, LOCK_RECORD);
  const now = options.now ?? (() => new Date());
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error("Workflow-home lock stale timeout must be a positive integer.");
  }

  async function readStored(): Promise<StoredLock | undefined> {
    try {
      const raw = await readFile(recordPath, "utf8");
      return parseStoredLock(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  async function writeStored(stored: StoredLock): Promise<void> {
    const temporary = path.join(directory, `${LOCK_RECORD}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(stored)}\n`, "utf8");
      await rename(temporary, recordPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  function isStale(stored: StoredLock, at: Date): boolean {
    if (stored.hostname === os.hostname()) {
      const alive = processIsAlive(stored.pid);
      if (alive === true || alive === undefined) return false;
      return true;
    }
    return Date.parse(stored.heartbeatAt) + staleAfterMs <= at.getTime();
  }

  async function reclaimIfStale(stored: StoredLock | undefined): Promise<boolean> {
    const at = checkedNow(now);
    if (stored && !isStale(stored, at)) return false;
    if (!stored) {
      // An incomplete freshly-created lock directory must not be removed while
      // its owner is still writing metadata. A malformed/interrupted record is
      // reclaimable only after the same conservative timeout.
      try {
        const info = await stat(directory);
        if (info.mtimeMs + staleAfterMs > at.getTime()) return false;
      } catch {
        return false;
      }
    }

    const quarantined = `${directory}.stale-${randomUUID()}`;
    try {
      await rename(directory, quarantined);
    } catch {
      return false;
    }
    await rm(quarantined, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }

  return {
    async acquire(input) {
      if (!isNonEmptyString(input.holderId)) {
        throw new Error("Workflow-home lock requires a non-empty holder ID.");
      }
      await mkdir(path.dirname(directory), { recursive: true });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const at = checkedNow(now);
        const candidate: StoredLock = {
          schema: LOCK_SCHEMA,
          version: LOCK_VERSION,
          holderId: input.holderId,
          token: randomUUID(),
          acquiredAt: at.toISOString(),
          heartbeatAt: at.toISOString(),
          hostname: os.hostname(),
          pid: process.pid,
        };
        try {
          await mkdir(directory, { recursive: false });
          try {
            await writeStored(candidate);
          } catch (error) {
            await rm(directory, { recursive: true, force: true }).catch(() => undefined);
            throw error;
          }
          return { acquired: true, lock: lockFromStored(candidate) };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST") throw error;
        }

        const observed = await readStored();
        if (observed && !isStale(observed, at)) {
          return { acquired: false, holderId: observed.holderId };
        }
        if (!(await reclaimIfStale(observed))) {
          const current = await readStored();
          return current
            ? { acquired: false, holderId: current.holderId }
            : { acquired: false };
        }
      }
      const current = await readStored();
      return current
        ? { acquired: false, holderId: current.holderId }
        : { acquired: false };
    },

    async renew(lock) {
      const observed = await readStored();
      if (!observed || !sameLock(lockFromStored(observed), lock)) {
        return { renewed: false };
      }
      const at = checkedNow(now);
      try {
        await writeStored({ ...observed, heartbeatAt: at.toISOString() });
        return { renewed: true };
      } catch {
        return { renewed: false };
      }
    },

    async release(lock) {
      const quarantined = `${directory}.release-${randomUUID()}`;
      try {
        await rename(directory, quarantined);
      } catch {
        return { released: false };
      }
      const movedRecordPath = path.join(quarantined, LOCK_RECORD);
      let observed: StoredLock | undefined;
      try {
        observed = parseStoredLock(JSON.parse(await readFile(movedRecordPath, "utf8")));
      } catch {
        observed = undefined;
      }
      if (observed && sameLock(lockFromStored(observed), lock)) {
        await rm(quarantined, { recursive: true, force: true }).catch(() => undefined);
        return { released: true };
      }
      // Never delete a lock that changed hands while release was in flight.
      try {
        await rename(quarantined, directory);
      } catch {
        // A newer owner acquired the original path. Keep the quarantined record
        // rather than overwrite it; a later stale-cleanup pass removes it.
      }
      return { released: false };
    },
  };
}

/** Shared in-memory store for deterministic Workflow-home lock tests. */
export class InMemoryWorkflowHomeLockStore {
  lock: WorkflowHomeLock | undefined;
}

export type InMemoryWorkflowHomeLockPortOptions = {
  store?: InMemoryWorkflowHomeLockStore;
};

/** Deterministic fake for local checkout-ownership tests. */
export function createInMemoryWorkflowHomeLockPort(
  options: InMemoryWorkflowHomeLockPortOptions = {},
): WorkflowHomeLockPort {
  const store = options.store ?? new InMemoryWorkflowHomeLockStore();
  return {
    async acquire(input) {
      if (store.lock) return { acquired: false, holderId: store.lock.holderId };
      const lock: WorkflowHomeLock = {
        holderId: input.holderId,
        token: randomUUID(),
        acquiredAt: new Date().toISOString(),
      };
      store.lock = lock;
      return { acquired: true, lock: copyLock(lock) };
    },
    async renew(lock) {
      return { renewed: store.lock !== undefined && sameLock(store.lock, lock) };
    },
    async release(lock) {
      if (!store.lock || !sameLock(store.lock, lock)) return { released: false };
      store.lock = undefined;
      return { released: true };
    },
  };
}

export function createInMemoryWorkflowHomeLockStore(): InMemoryWorkflowHomeLockStore {
  return new InMemoryWorkflowHomeLockStore();
}
