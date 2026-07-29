import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  canonicalRepositoryIdentityKey,
  canonicalTargetIdentitiesEqual,
  canonicalTargetIdentityKey,
  isCanonicalRepositoryIdentity,
  isCanonicalTargetIdentity,
} from "../coordination.js";
import { DEFAULT_COORDINATION_LEASE_TTL_MS } from "../constants.js";
import type {
  AcquireCoordinationLeaseInput,
  CoordinationLeaseKey,
  CoordinationPort,
  RenewCoordinationLeaseResult,
} from "../ports.js";
import type {
  CanonicalRepositoryIdentity,
  CanonicalTargetIdentity,
  CoordinationLease,
  RepositoryWorkerCapacityPolicy,
} from "../types.js";

const execFileAsync = promisify(execFile);

/** Reserved Git namespace for all version-one Matt Auto coordination records. */
export const COORDINATION_REF_PREFIX = "refs/matt-auto/coordination/v1";
const LEASE_REF_PREFIX = `${COORDINATION_REF_PREFIX}/leases/`;
const POLICY_REF_PREFIX = `${COORDINATION_REF_PREFIX}/policies/`;
const RECORD_FILE = "coordination.json";
const LEASE_RECORD_SCHEMA = "matt-auto/coordination-lease";
const POLICY_RECORD_SCHEMA = "matt-auto/repository-worker-capacity-policy";
const RECORD_VERSION = 1;

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

type GitResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type StoredRecord = {
  /** Exact remote object ID observed with the serialized record. */
  version: string;
  body: string;
};

type ListedStoredRecord = StoredRecord & { ref: string };

type CoordinationRecordStore = {
  get(ref: string): Promise<StoredRecord | undefined>;
  list(prefix: string): Promise<readonly ListedStoredRecord[]>;
  /** Compare against the exact observed version; undefined means the ref must be absent. */
  compareAndSet(
    ref: string,
    expectedVersion: string | undefined,
    body: string,
  ): Promise<boolean>;
};

/** Options for the real Git-backed CoordinationPort. */
export type CoordinationPortOptions = {
  /** Git remote containing the reserved coordination refs. Defaults to `origin`. */
  remoteName?: string;
  /** Injected wall clock for deterministic adapter tests. */
  now?: () => Date;
  /** Default positive renewal TTL. Individual acquire/renew calls may override it. */
  defaultLeaseTtlMs?: number;
};

/**
 * In-memory store shared by deterministic fake coordination ports. Its revision
 * number models the exact remote ref object ID used by the Git-backed adapter.
 */
export class InMemoryCoordinationStore implements CoordinationRecordStore {
  readonly #records = new Map<string, StoredRecord>();
  #nextRevision = 1;

  async get(ref: string): Promise<StoredRecord | undefined> {
    const current = this.#records.get(ref);
    return current ? { ...current } : undefined;
  }

  async list(prefix: string): Promise<readonly ListedStoredRecord[]> {
    return [...this.#records.entries()]
      .filter(([ref]) => ref.startsWith(prefix))
      .map(([ref, record]) => ({ ref, ...record }))
      .sort((left, right) => left.ref.localeCompare(right.ref));
  }

  async compareAndSet(
    ref: string,
    expectedVersion: string | undefined,
    body: string,
  ): Promise<boolean> {
    const current = this.#records.get(ref);
    if (current?.version !== expectedVersion) return false;
    if (!current && expectedVersion !== undefined) return false;
    this.#records.set(ref, {
      version: `memory-${this.#nextRevision++}`,
      body,
    });
    return true;
  }

}

/** Options for a deterministic fake CoordinationPort. Pass one store to share state. */
export type InMemoryCoordinationPortOptions = Omit<
  CoordinationPortOptions,
  "remoteName"
> & {
  store?: InMemoryCoordinationStore;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoInstant(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value.slice(0, 10)
  );
}

function cloneRepository(
  repository: CanonicalRepositoryIdentity,
): CanonicalRepositoryIdentity {
  return { owner: repository.owner, name: repository.name };
}

function cloneTarget(target: CanonicalTargetIdentity): CanonicalTargetIdentity {
  return {
    repository: cloneRepository(target.repository),
    targetRef: target.targetRef,
  };
}

function repositoriesEqual(
  left: CanonicalRepositoryIdentity,
  right: CanonicalRepositoryIdentity,
): boolean {
  return canonicalRepositoryIdentityKey(left) === canonicalRepositoryIdentityKey(right);
}

function isValidLeaseTtl(value: unknown): value is number {
  return isPositiveInteger(value);
}

function assertLeaseTtl(value: unknown, label = "Coordination lease TTL"): asserts value is number {
  if (!isValidLeaseTtl(value)) {
    throw new Error(`${label} must be a positive integer number of milliseconds.`);
  }
}

function assertRepository(repository: unknown): asserts repository is CanonicalRepositoryIdentity {
  if (!isCanonicalRepositoryIdentity(repository)) {
    throw new Error("Coordination requires a canonical GitHub repository identity.");
  }
}

function assertTarget(target: unknown): asserts target is CanonicalTargetIdentity {
  if (!isCanonicalTargetIdentity(target)) {
    throw new Error("Coordination requires a canonical GitHub Target identity.");
  }
}

/** Runtime validation for a deterministic lease-ref key. */
export function assertCoordinationLeaseKey(
  key: CoordinationLeaseKey,
): void {
  switch (key.kind) {
    case "workflow-coordinator":
      assertRepository(key.repository);
      assertTarget(key.target);
      if (!repositoriesEqual(key.repository, key.target.repository)) {
        throw new Error(
          "A Workflow coordinator lease repository must match its Target repository.",
        );
      }
      if (!isPositiveInteger(key.workflowId)) {
        throw new Error("A Workflow coordinator lease requires a positive Workflow ID.");
      }
      return;
    case "target-branch":
      assertTarget(key.target);
      return;
    case "repository-scheduler":
      assertRepository(key.repository);
      return;
    case "worker-slot":
      assertRepository(key.repository);
      if (!isPositiveInteger(key.slot)) {
        throw new Error("A worker-slot lease requires a positive slot number.");
      }
      return;
  }
}

function assertAcquireInput(input: AcquireCoordinationLeaseInput): void {
  assertCoordinationLeaseKey(input);
  if (!isNonEmptyString(input.holderId)) {
    throw new Error("A coordination lease requires a non-empty holder ID.");
  }
  if (input.ttlMs !== undefined) assertLeaseTtl(input.ttlMs);
  switch (input.kind) {
    case "workflow-coordinator":
    case "repository-scheduler":
      return;
    case "target-branch":
      if (input.workflowId !== undefined && !isPositiveInteger(input.workflowId)) {
        throw new Error("A Target-branch lease Workflow ID must be a positive integer.");
      }
      return;
    case "worker-slot":
      if (!isPositiveInteger(input.workflowId)) {
        throw new Error("A worker-slot lease requires a positive Workflow ID.");
      }
      if (input.ticketNumber !== undefined && !isPositiveInteger(input.ticketNumber)) {
        throw new Error("A worker-slot ticket number must be a positive integer.");
      }
      return;
  }
}

function leaseKeyFromLease(lease: CoordinationLease): CoordinationLeaseKey {
  switch (lease.kind) {
    case "workflow-coordinator":
      return {
        kind: lease.kind,
        repository: cloneRepository(lease.scope.repository),
        target: cloneTarget(lease.scope.target),
        workflowId: lease.scope.workflowId,
      };
    case "target-branch":
      return { kind: lease.kind, target: cloneTarget(lease.scope.target) };
    case "repository-scheduler":
      return {
        kind: lease.kind,
        repository: cloneRepository(lease.scope.repository),
      };
    case "worker-slot":
      return {
        kind: lease.kind,
        repository: cloneRepository(lease.scope.repository),
        slot: lease.scope.slot,
      };
  }
}

function leaseKeyFromAcquireInput(
  input: AcquireCoordinationLeaseInput,
): CoordinationLeaseKey {
  switch (input.kind) {
    case "workflow-coordinator":
      return {
        kind: input.kind,
        repository: cloneRepository(input.repository),
        target: cloneTarget(input.target),
        workflowId: input.workflowId,
      };
    case "target-branch":
      return { kind: input.kind, target: cloneTarget(input.target) };
    case "repository-scheduler":
      return {
        kind: input.kind,
        repository: cloneRepository(input.repository),
      };
    case "worker-slot":
      return {
        kind: input.kind,
        repository: cloneRepository(input.repository),
        slot: input.slot,
      };
  }
}

function leaseKeysEqual(
  left: CoordinationLeaseKey,
  right: CoordinationLeaseKey,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "workflow-coordinator":
      return (
        right.kind === left.kind &&
        repositoriesEqual(left.repository, right.repository) &&
        canonicalTargetIdentitiesEqual(left.target, right.target) &&
        left.workflowId === right.workflowId
      );
    case "target-branch":
      return (
        right.kind === left.kind &&
        canonicalTargetIdentitiesEqual(left.target, right.target)
      );
    case "repository-scheduler":
      return (
        right.kind === left.kind &&
        repositoriesEqual(left.repository, right.repository)
      );
    case "worker-slot":
      return (
        right.kind === left.kind &&
        repositoriesEqual(left.repository, right.repository) &&
        left.slot === right.slot
      );
  }
}

function repositoryFromLease(lease: CoordinationLease): CanonicalRepositoryIdentity {
  switch (lease.kind) {
    case "workflow-coordinator":
    case "repository-scheduler":
    case "worker-slot":
      return lease.scope.repository;
    case "target-branch":
      return lease.scope.target.repository;
  }
}

function optionalNumbersEqual(left: number | undefined, right: number | undefined): boolean {
  return left === right;
}

/**
 * Compare a lease's stable fencing identity. Heartbeat and expiry intentionally
 * do not participate so an already-held lease remains usable after renewal.
 */
function fencingMatches(
  current: CoordinationLease,
  expected: CoordinationLease,
): boolean {
  if (
    current.kind !== expected.kind ||
    current.holderId !== expected.holderId ||
    current.generation !== expected.generation ||
    current.acquiredAt !== expected.acquiredAt ||
    !leaseKeysEqual(leaseKeyFromLease(current), leaseKeyFromLease(expected))
  ) {
    return false;
  }
  switch (current.kind) {
    case "workflow-coordinator":
    case "repository-scheduler":
      return true;
    case "target-branch":
      return (
        expected.kind === current.kind &&
        optionalNumbersEqual(current.workflowId, expected.workflowId)
      );
    case "worker-slot":
      return (
        expected.kind === current.kind &&
        current.workflowId === expected.workflowId &&
        optionalNumbersEqual(current.ticketNumber, expected.ticketNumber)
      );
  }
}

function isLeaseExpired(lease: CoordinationLease, nowMs: number): boolean {
  return Date.parse(lease.expiresAt) <= nowMs;
}

function isLeaseReleased(lease: CoordinationLease): boolean {
  return lease.releasedAt !== undefined;
}

function checkedNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Coordination clock returned an invalid Date.");
  }
  return new Date(value.getTime());
}

function atIso(date: Date): string {
  return date.toISOString();
}

function expiresAt(now: Date, ttlMs: number): string {
  const milliseconds = now.getTime() + ttlMs;
  const expiry = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || !Number.isFinite(expiry.getTime())) {
    throw new Error("Coordination lease expiry is outside the supported Date range.");
  }
  return expiry.toISOString();
}

function buildLease(
  input: AcquireCoordinationLeaseInput,
  generation: number,
  now: Date,
  ttlMs: number,
): CoordinationLease {
  const common = {
    holderId: input.holderId,
    generation,
    acquiredAt: atIso(now),
    heartbeatAt: atIso(now),
    expiresAt: expiresAt(now, ttlMs),
  };
  switch (input.kind) {
    case "workflow-coordinator":
      return {
        kind: input.kind,
        ...common,
        scope: {
          repository: cloneRepository(input.repository),
          target: cloneTarget(input.target),
          workflowId: input.workflowId,
        },
      };
    case "target-branch":
      return {
        kind: input.kind,
        ...common,
        scope: { target: cloneTarget(input.target) },
        ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
      };
    case "repository-scheduler":
      return {
        kind: input.kind,
        ...common,
        scope: { repository: cloneRepository(input.repository) },
      };
    case "worker-slot":
      return {
        kind: input.kind,
        ...common,
        scope: {
          repository: cloneRepository(input.repository),
          slot: input.slot,
        },
        workflowId: input.workflowId,
        ...(input.ticketNumber === undefined
          ? {}
          : { ticketNumber: input.ticketNumber }),
      };
  }
}

function parseLeaseRecord(value: unknown): CoordinationLease | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.schema !== LEASE_RECORD_SCHEMA ||
    value.version !== RECORD_VERSION ||
    !isNonEmptyString(value.holderId) ||
    !isPositiveInteger(value.generation) ||
    !isIsoInstant(value.acquiredAt) ||
    !isIsoInstant(value.heartbeatAt) ||
    !isIsoInstant(value.expiresAt) ||
    (hasOwn(value, "releasedAt") && !isIsoInstant(value.releasedAt)) ||
    !isRecord(value.scope)
  ) {
    return undefined;
  }
  const acquiredAt = Date.parse(value.acquiredAt);
  const heartbeatAt = Date.parse(value.heartbeatAt);
  const expiry = Date.parse(value.expiresAt);
  if (heartbeatAt < acquiredAt || expiry <= heartbeatAt) return undefined;
  const released = hasOwn(value, "releasedAt")
    ? { releasedAt: value.releasedAt as string }
    : {};

  switch (value.kind) {
    case "workflow-coordinator": {
      const repository = value.scope.repository;
      const target = value.scope.target;
      if (
        !isCanonicalRepositoryIdentity(repository) ||
        !isCanonicalTargetIdentity(target) ||
        !repositoriesEqual(repository, target.repository) ||
        !isPositiveInteger(value.scope.workflowId)
      ) {
        return undefined;
      }
      return {
        kind: value.kind,
        holderId: value.holderId,
        generation: value.generation,
        acquiredAt: value.acquiredAt,
        heartbeatAt: value.heartbeatAt,
        expiresAt: value.expiresAt,
        ...released,
        scope: {
          repository: cloneRepository(repository),
          target: cloneTarget(target),
          workflowId: value.scope.workflowId,
        },
      };
    }
    case "target-branch": {
      const target = value.scope.target;
      if (!isCanonicalTargetIdentity(target)) return undefined;
      if (hasOwn(value, "workflowId") && !isPositiveInteger(value.workflowId)) {
        return undefined;
      }
      return {
        kind: value.kind,
        holderId: value.holderId,
        generation: value.generation,
        acquiredAt: value.acquiredAt,
        heartbeatAt: value.heartbeatAt,
        expiresAt: value.expiresAt,
        ...released,
        scope: { target: cloneTarget(target) },
        ...(hasOwn(value, "workflowId")
          ? { workflowId: value.workflowId as number }
          : {}),
      };
    }
    case "repository-scheduler": {
      const repository = value.scope.repository;
      if (!isCanonicalRepositoryIdentity(repository)) return undefined;
      return {
        kind: value.kind,
        holderId: value.holderId,
        generation: value.generation,
        acquiredAt: value.acquiredAt,
        heartbeatAt: value.heartbeatAt,
        expiresAt: value.expiresAt,
        ...released,
        scope: { repository: cloneRepository(repository) },
      };
    }
    case "worker-slot": {
      const repository = value.scope.repository;
      if (
        !isCanonicalRepositoryIdentity(repository) ||
        !isPositiveInteger(value.scope.slot) ||
        !isPositiveInteger(value.workflowId) ||
        (hasOwn(value, "ticketNumber") && !isPositiveInteger(value.ticketNumber))
      ) {
        return undefined;
      }
      return {
        kind: value.kind,
        holderId: value.holderId,
        generation: value.generation,
        acquiredAt: value.acquiredAt,
        heartbeatAt: value.heartbeatAt,
        expiresAt: value.expiresAt,
        ...released,
        scope: {
          repository: cloneRepository(repository),
          slot: value.scope.slot,
        },
        workflowId: value.workflowId,
        ...(hasOwn(value, "ticketNumber")
          ? { ticketNumber: value.ticketNumber as number }
          : {}),
      };
    }
    default:
      return undefined;
  }
}

function normalizeLease(lease: CoordinationLease): CoordinationLease {
  const parsed = parseLeaseRecord({
    schema: LEASE_RECORD_SCHEMA,
    version: RECORD_VERSION,
    ...lease,
  });
  if (!parsed) {
    throw new Error("Invalid coordination lease supplied to the CoordinationPort.");
  }
  return parsed;
}

function leaseRecordBody(lease: CoordinationLease): string {
  return JSON.stringify({
    schema: LEASE_RECORD_SCHEMA,
    version: RECORD_VERSION,
    ...lease,
  });
}

function parsePolicyRecord(
  value: unknown,
): RepositoryWorkerCapacityPolicy | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.schema !== POLICY_RECORD_SCHEMA ||
    value.version !== RECORD_VERSION ||
    !isCanonicalRepositoryIdentity(value.repository) ||
    !isPositiveInteger(value.workerCapacity) ||
    !isPositiveInteger(value.generation) ||
    !isIsoInstant(value.initializedAt) ||
    !isIsoInstant(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.initializedAt)
  ) {
    return undefined;
  }
  return {
    schema: POLICY_RECORD_SCHEMA,
    version: RECORD_VERSION,
    repository: cloneRepository(value.repository),
    workerCapacity: value.workerCapacity,
    generation: value.generation,
    initializedAt: value.initializedAt,
    updatedAt: value.updatedAt,
  };
}

function policyRecordBody(policy: RepositoryWorkerCapacityPolicy): string {
  return JSON.stringify(policy);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryRefSegment(repository: CanonicalRepositoryIdentity): string {
  return digest(canonicalRepositoryIdentityKey(repository));
}

function targetRefSegment(target: CanonicalTargetIdentity): string {
  return digest(canonicalTargetIdentityKey(target));
}

/** Deterministic reserved remote ref for a lease identity. */
export function coordinationLeaseRefName(key: CoordinationLeaseKey): string {
  assertCoordinationLeaseKey(key);
  switch (key.kind) {
    case "workflow-coordinator":
      return `${LEASE_REF_PREFIX}workflow-coordinator/${repositoryRefSegment(key.repository)}/${targetRefSegment(key.target)}/${key.workflowId}`;
    case "target-branch":
      return `${LEASE_REF_PREFIX}target-branch/${targetRefSegment(key.target)}`;
    case "repository-scheduler":
      return `${LEASE_REF_PREFIX}repository-scheduler/${repositoryRefSegment(key.repository)}`;
    case "worker-slot":
      return `${LEASE_REF_PREFIX}worker-slot/${repositoryRefSegment(key.repository)}/${key.slot}`;
  }
}

/** Deterministic reserved remote ref for the repository-wide capacity policy. */
export function workerCapacityPolicyRefName(
  repository: CanonicalRepositoryIdentity,
): string {
  assertRepository(repository);
  return `${POLICY_REF_PREFIX}repository-worker-capacity/${repositoryRefSegment(repository)}`;
}

function throwInvalidRecord(ref: string, type: "lease" | "worker capacity policy"): never {
  throw new Error(
    `Reserved coordination ref ${ref} contains an invalid ${type} record; refusing to infer ownership.`,
  );
}

function parseStoredLease(ref: string, body: string): CoordinationLease {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return throwInvalidRecord(ref, "lease");
  }
  const lease = parseLeaseRecord(raw);
  if (!lease) return throwInvalidRecord(ref, "lease");
  const expectedRef = coordinationLeaseRefName(leaseKeyFromLease(lease));
  if (expectedRef !== ref) {
    throw new Error(
      `Lease record at ${ref} does not match its deterministic coordination scope.`,
    );
  }
  return lease;
}

function parseStoredPolicy(
  ref: string,
  body: string,
): RepositoryWorkerCapacityPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return throwInvalidRecord(ref, "worker capacity policy");
  }
  const policy = parsePolicyRecord(raw);
  if (!policy) return throwInvalidRecord(ref, "worker capacity policy");
  if (workerCapacityPolicyRefName(policy.repository) !== ref) {
    throw new Error(
      `Worker-capacity policy at ${ref} does not match its deterministic repository scope.`,
    );
  }
  return policy;
}

function copyLease(lease: CoordinationLease): CoordinationLease {
  // All DTO fields are JSON primitives; this prevents callers from mutating a
  // returned nested scope object and accidentally changing later comparisons.
  return JSON.parse(JSON.stringify(lease)) as CoordinationLease;
}

function copyPolicy(
  policy: RepositoryWorkerCapacityPolicy,
): RepositoryWorkerCapacityPolicy {
  return JSON.parse(JSON.stringify(policy)) as RepositoryWorkerCapacityPolicy;
}

function remoteNameOrThrow(remoteName: string): string {
  const trimmed = remoteName.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(trimmed)) {
    throw new Error("Coordination remote name must be a simple configured Git remote name.");
  }
  return trimmed;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      ...(env ? { env } : {}),
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

function gitFailure(description: string, result: GitResult): Error {
  const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim();
  return new Error(`${description}: ${detail}`);
}

function parseRemoteRefOutput(
  stdout: string,
  expectedRef?: string,
): Array<{ oid: string; ref: string }> {
  const refs: Array<{ oid: string; ref: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(\S+)\s+(\S+)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    const [, oid, ref] = match;
    if (!GIT_OBJECT_ID.test(oid)) {
      throw new Error(`Git remote returned an invalid object ID for ${ref}.`);
    }
    if (expectedRef && ref !== expectedRef) continue;
    refs.push({ oid, ref });
  }
  return refs;
}

function createGitRecordStore(
  workflowRoot: string,
  remoteName: string,
): CoordinationRecordStore {
  const root = path.resolve(workflowRoot);
  const remote = remoteNameOrThrow(remoteName);
  let zeroObjectId: string | undefined;

  async function remoteRefOid(ref: string): Promise<string | undefined> {
    const result = await runGit(root, ["ls-remote", "--refs", remote, ref]);
    if (result.code !== 0) {
      throw gitFailure(`git ls-remote ${remote} ${ref} failed`, result);
    }
    const refs = parseRemoteRefOutput(result.stdout, ref);
    if (refs.length > 1) {
      throw new Error(`Git remote returned multiple values for coordination ref ${ref}.`);
    }
    return refs[0]?.oid;
  }

  async function remoteRefs(prefix: string): Promise<readonly string[]> {
    const result = await runGit(root, [
      "ls-remote",
      "--refs",
      remote,
      `${prefix}*`,
    ]);
    if (result.code !== 0) {
      throw gitFailure(`git ls-remote ${remote} ${prefix}* failed`, result);
    }
    return parseRemoteRefOutput(result.stdout)
      .map((entry) => entry.ref)
      .filter((ref) => ref.startsWith(prefix))
      .sort();
  }

  async function loadRecordAtRef(ref: string): Promise<StoredRecord | undefined> {
    // A ref can move between ls-remote and fetch. Retrying gives a fresh,
    // coherent snapshot; any later move is still caught by compare-and-set.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const oid = await remoteRefOid(ref);
      if (!oid) return undefined;

      const fetched = await runGit(root, [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        remote,
        ref,
      ]);
      if (fetched.code !== 0) {
        const later = await remoteRefOid(ref);
        if (later !== oid) continue;
        throw gitFailure(`git fetch coordination ref ${ref} failed`, fetched);
      }

      const shown = await runGit(root, ["show", `${oid}:${RECORD_FILE}`]);
      if (shown.code === 0) {
        return { version: oid, body: shown.stdout };
      }
      const later = await remoteRefOid(ref);
      if (later !== oid) continue;
      throw gitFailure(`Could not read coordination record ${oid}:${RECORD_FILE}`, shown);
    }
    throw new Error(`Coordination ref ${ref} changed repeatedly while being read.`);
  }

  async function objectFormatZero(): Promise<string> {
    if (zeroObjectId) return zeroObjectId;
    const result = await runGit(root, ["rev-parse", "--show-object-format"]);
    if (result.code !== 0) {
      throw gitFailure("Could not determine local Git object format", result);
    }
    const format = result.stdout.trim();
    if (format === "sha1") {
      zeroObjectId = "0".repeat(40);
    } else if (format === "sha256") {
      zeroObjectId = "0".repeat(64);
    } else {
      throw new Error(`Unsupported Git object format for coordination: ${format || "(empty)"}.`);
    }
    return zeroObjectId;
  }

  async function createRecordCommit(body: string): Promise<string> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "matt-auto-coordination-"));
    const recordPath = path.join(tempDir, RECORD_FILE);
    const indexPath = path.join(tempDir, "index");
    try {
      await writeFile(recordPath, body, "utf8");
      const blob = await runGit(root, ["hash-object", "-w", recordPath]);
      if (blob.code !== 0) {
        throw gitFailure("Could not write coordination record blob", blob);
      }
      const blobOid = blob.stdout.trim();
      if (!GIT_OBJECT_ID.test(blobOid)) {
        throw new Error("git hash-object returned an invalid coordination blob ID.");
      }

      const recordEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: indexPath,
      };
      const emptyIndex = await runGit(root, ["read-tree", "--empty"], recordEnv);
      if (emptyIndex.code !== 0) {
        throw gitFailure("Could not create an isolated coordination index", emptyIndex);
      }
      const updatedIndex = await runGit(
        root,
        ["update-index", "--add", "--cacheinfo", `100644,${blobOid},${RECORD_FILE}`],
        recordEnv,
      );
      if (updatedIndex.code !== 0) {
        throw gitFailure("Could not add coordination record to an isolated tree", updatedIndex);
      }
      const tree = await runGit(root, ["write-tree"], recordEnv);
      if (tree.code !== 0) {
        throw gitFailure("Could not write coordination record tree", tree);
      }
      const treeOid = tree.stdout.trim();
      if (!GIT_OBJECT_ID.test(treeOid)) {
        throw new Error("git write-tree returned an invalid coordination tree ID.");
      }

      const commitEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: "Matt Auto Coordination",
        GIT_AUTHOR_EMAIL: "matt-auto@invalid",
        GIT_COMMITTER_NAME: "Matt Auto Coordination",
        GIT_COMMITTER_EMAIL: "matt-auto@invalid",
      };
      // Give each conditional-write attempt a distinct commit object even when
      // two contenders serialize identical JSON in the same Git timestamp
      // second. Otherwise Git may report an already-current ref as a successful
      // no-op and bypass the caller's expected-absent lease condition.
      const commit = await runGit(
        root,
        [
          "commit-tree",
          treeOid,
          "-m",
          `matt-auto coordination record ${randomUUID()}`,
        ],
        commitEnv,
      );
      if (commit.code !== 0) {
        throw gitFailure("Could not create coordination record commit", commit);
      }
      const commitOid = commit.stdout.trim();
      if (!GIT_OBJECT_ID.test(commitOid)) {
        throw new Error("git commit-tree returned an invalid coordination commit ID.");
      }
      return commitOid;
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function conditionalPush(
    ref: string,
    expectedVersion: string | undefined,
    nextOid: string,
  ): Promise<boolean> {
    const expected = expectedVersion ?? (await objectFormatZero());
    const refspec = `${nextOid}:${ref}`;
    // Deliberately do not add `+` or `--force`: either disables the exact
    // --force-with-lease protection for a non-fast-forward coordination record.
    const pushed = await runGit(root, [
      "push",
      `--force-with-lease=${ref}:${expected}`,
      remote,
      refspec,
    ]);
    if (pushed.code === 0) return true;

    // A changed ref is a normal race. If it did not change, surface the push
    // failure (permissions, transport, protected namespace, etc.) instead of
    // accidentally treating an infrastructure failure as a harmless contender.
    const current = await remoteRefOid(ref);
    if (current !== expectedVersion) return false;
    throw gitFailure(`Conditional coordination push for ${ref} failed`, pushed);
  }

  return {
    get: loadRecordAtRef,
    async list(prefix) {
      const refs = await remoteRefs(prefix);
      const records: ListedStoredRecord[] = [];
      for (const ref of refs) {
        const record = await loadRecordAtRef(ref);
        if (record) records.push({ ref, ...record });
      }
      return records;
    },
    async compareAndSet(ref, expectedVersion, body) {
      const next = await createRecordCommit(body);
      return conditionalPush(ref, expectedVersion, next);
    },
  };
}

function createCoordinationPortFromStore(
  store: CoordinationRecordStore,
  options: Omit<CoordinationPortOptions, "remoteName"> = {},
): CoordinationPort {
  const now = options.now ?? (() => new Date());
  const defaultLeaseTtlMs =
    options.defaultLeaseTtlMs ?? DEFAULT_COORDINATION_LEASE_TTL_MS;
  assertLeaseTtl(defaultLeaseTtlMs, "Default coordination lease TTL");

  async function readLeaseSnapshot(
    key: CoordinationLeaseKey,
  ): Promise<{ record: StoredRecord; lease: CoordinationLease } | undefined> {
    assertCoordinationLeaseKey(key);
    const ref = coordinationLeaseRefName(key);
    const record = await store.get(ref);
    if (!record) return undefined;
    const lease = parseStoredLease(ref, record.body);
    if (!leaseKeysEqual(leaseKeyFromLease(lease), key)) {
      throw new Error(
        `Lease record at ${ref} does not match the requested coordination scope.`,
      );
    }
    return { record, lease };
  }

  async function readPolicySnapshot(
    repository: CanonicalRepositoryIdentity,
  ): Promise<
    | { record: StoredRecord; policy: RepositoryWorkerCapacityPolicy }
    | undefined
  > {
    assertRepository(repository);
    const ref = workerCapacityPolicyRefName(repository);
    const record = await store.get(ref);
    if (!record) return undefined;
    const policy = parseStoredPolicy(ref, record.body);
    if (!repositoriesEqual(policy.repository, repository)) {
      throw new Error(
        `Worker-capacity policy at ${ref} does not match the requested repository.`,
      );
    }
    return { record, policy };
  }

  function failedRenewal(
    current: CoordinationLease | undefined,
    expected: CoordinationLease,
    nowMs: number,
  ): RenewCoordinationLeaseResult {
    if (!current) return { renewed: false, reason: "not-found" };
    if (isLeaseReleased(current)) {
      return { renewed: false, reason: "lost", lease: copyLease(current) };
    }
    if (!fencingMatches(current, expected)) {
      return { renewed: false, reason: "lost", lease: copyLease(current) };
    }
    if (isLeaseExpired(current, nowMs)) {
      return { renewed: false, reason: "expired", lease: copyLease(current) };
    }
    return { renewed: false, reason: "contended", lease: copyLease(current) };
  }

  return {
    async getLease(key) {
      const snapshot = await readLeaseSnapshot(key);
      return snapshot ? copyLease(snapshot.lease) : undefined;
    },

    async listLeases(input) {
      assertRepository(input.repository);
      const records = await store.list(LEASE_REF_PREFIX);
      const leases: CoordinationLease[] = [];
      for (const record of records) {
        const lease = parseStoredLease(record.ref, record.body);
        if (!repositoriesEqual(repositoryFromLease(lease), input.repository)) {
          continue;
        }
        if (input.kind !== undefined && lease.kind !== input.kind) continue;
        leases.push(copyLease(lease));
      }
      return leases.sort((left, right) => {
        const leftRef = coordinationLeaseRefName(leaseKeyFromLease(left));
        const rightRef = coordinationLeaseRefName(leaseKeyFromLease(right));
        return leftRef.localeCompare(rightRef);
      });
    },

    async acquireLease(input) {
      assertAcquireInput(input);
      const key = leaseKeyFromAcquireInput(input);
      const ref = coordinationLeaseRefName(key);
      const observed = await readLeaseSnapshot(key);
      const at = checkedNow(now);
      if (
        observed &&
        !isLeaseReleased(observed.lease) &&
        !isLeaseExpired(observed.lease, at.getTime())
      ) {
        return {
          acquired: false,
          reason: "held",
          lease: copyLease(observed.lease),
        };
      }

      const ttlMs = input.ttlMs ?? defaultLeaseTtlMs;
      const generation = (observed?.lease.generation ?? 0) + 1;
      const candidate = buildLease(input, generation, at, ttlMs);
      const acquired = await store.compareAndSet(
        ref,
        observed?.record.version,
        leaseRecordBody(candidate),
      );
      if (acquired) return { acquired: true, lease: copyLease(candidate) };

      const current = await readLeaseSnapshot(key);
      return {
        acquired: false,
        reason: "contended",
        ...(current ? { lease: copyLease(current.lease) } : {}),
      };
    },

    async renewLease(input) {
      const expected = normalizeLease(input.lease);
      if (input.ttlMs !== undefined) assertLeaseTtl(input.ttlMs);
      const key = leaseKeyFromLease(expected);
      const ref = coordinationLeaseRefName(key);
      const observed = await readLeaseSnapshot(key);
      const at = checkedNow(now);
      if (!observed) return { renewed: false, reason: "not-found" };
      if (isLeaseReleased(observed.lease)) {
        return { renewed: false, reason: "lost", lease: copyLease(observed.lease) };
      }
      if (!fencingMatches(observed.lease, expected)) {
        return { renewed: false, reason: "lost", lease: copyLease(observed.lease) };
      }
      if (isLeaseExpired(observed.lease, at.getTime())) {
        return { renewed: false, reason: "expired", lease: copyLease(observed.lease) };
      }

      const ttlMs = input.ttlMs ?? defaultLeaseTtlMs;
      const renewed: CoordinationLease = {
        ...observed.lease,
        heartbeatAt: atIso(at),
        expiresAt: expiresAt(at, ttlMs),
      };
      const written = await store.compareAndSet(
        ref,
        observed.record.version,
        leaseRecordBody(renewed),
      );
      if (written) return { renewed: true, lease: copyLease(renewed) };

      const current = await readLeaseSnapshot(key);
      return failedRenewal(current?.lease, expected, at.getTime());
    },

    async releaseLease(lease) {
      const expected = normalizeLease(lease);
      const key = leaseKeyFromLease(expected);
      const ref = coordinationLeaseRefName(key);
      const observed = await readLeaseSnapshot(key);
      if (!observed) return { released: false, reason: "not-found" };
      if (
        isLeaseReleased(observed.lease) ||
        !fencingMatches(observed.lease, expected) ||
        isLeaseExpired(observed.lease, checkedNow(now).getTime())
      ) {
        return { released: false, reason: "lost" };
      }
      // Keep a released tombstone at the same ref. Deleting it would reset the
      // next acquire to generation one and let an old fencing token recur.
      const releasedLease: CoordinationLease = {
        ...observed.lease,
        releasedAt: atIso(checkedNow(now)),
      };
      const released = await store.compareAndSet(
        ref,
        observed.record.version,
        leaseRecordBody(releasedLease),
      );
      if (released) return { released: true };

      const current = await readLeaseSnapshot(key);
      if (!current) return { released: false, reason: "not-found" };
      return {
        released: false,
        reason:
          !isLeaseReleased(current.lease) && fencingMatches(current.lease, expected)
            ? "contended"
            : "lost",
      };
    },

    async verifyLease(lease) {
      const expected = normalizeLease(lease);
      const key = leaseKeyFromLease(expected);
      const observed = await readLeaseSnapshot(key);
      if (!observed) return { valid: false, reason: "not-found" };
      if (isLeaseReleased(observed.lease)) {
        return { valid: false, reason: "lost", lease: copyLease(observed.lease) };
      }
      if (!fencingMatches(observed.lease, expected)) {
        return { valid: false, reason: "lost", lease: copyLease(observed.lease) };
      }
      const at = checkedNow(now);
      if (isLeaseExpired(observed.lease, at.getTime())) {
        return { valid: false, reason: "expired", lease: copyLease(observed.lease) };
      }
      return { valid: true, lease: copyLease(observed.lease) };
    },

    async canWriteCoordinationRefs(repository) {
      try {
        assertRepository(repository);
        // Read path proves the reserved namespace is reachable. A successful
        // list/get does not mutate durable coordination state (preflight-safe).
        await store.list(LEASE_REF_PREFIX);
        await readPolicySnapshot(repository);
        return { ok: true as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false as const,
          reason:
            message.trim() ||
            "Could not access the reserved Matt Auto coordination-ref namespace.",
        };
      }
    },

    async getWorkerCapacityPolicy(repository) {
      const snapshot = await readPolicySnapshot(repository);
      return snapshot ? copyPolicy(snapshot.policy) : undefined;
    },

    async ensureWorkerCapacityPolicy(input) {
      assertRepository(input.repository);
      if (!isPositiveInteger(input.seedWorkerCapacity)) {
        throw new Error("Repository worker capacity seed must be a positive integer.");
      }
      const ref = workerCapacityPolicyRefName(input.repository);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const observed = await readPolicySnapshot(input.repository);
        if (observed) {
          return { policy: copyPolicy(observed.policy), initialized: false };
        }
        const at = atIso(checkedNow(now));
        const candidate: RepositoryWorkerCapacityPolicy = {
          schema: POLICY_RECORD_SCHEMA,
          version: RECORD_VERSION,
          repository: cloneRepository(input.repository),
          workerCapacity: input.seedWorkerCapacity,
          generation: 1,
          initializedAt: at,
          updatedAt: at,
        };
        const initialized = await store.compareAndSet(
          ref,
          undefined,
          policyRecordBody(candidate),
        );
        if (initialized) {
          return { policy: copyPolicy(candidate), initialized: true };
        }
        const current = await readPolicySnapshot(input.repository);
        if (current) {
          return { policy: copyPolicy(current.policy), initialized: false };
        }
      }
      throw new Error(
        "Repository worker-capacity policy changed repeatedly while being initialized.",
      );
    },

    async updateWorkerCapacityPolicy(input) {
      assertRepository(input.repository);
      if (!isPositiveInteger(input.workerCapacity)) {
        throw new Error("Repository worker capacity must be a positive integer.");
      }
      if (!isPositiveInteger(input.expectedGeneration)) {
        throw new Error("Expected worker-capacity policy generation must be a positive integer.");
      }
      const ref = workerCapacityPolicyRefName(input.repository);
      const observed = await readPolicySnapshot(input.repository);
      if (!observed) return { updated: false, reason: "not-found" };
      if (observed.policy.generation !== input.expectedGeneration) {
        return {
          updated: false,
          reason: "generation-mismatch",
          policy: copyPolicy(observed.policy),
        };
      }
      const candidate: RepositoryWorkerCapacityPolicy = {
        ...observed.policy,
        workerCapacity: input.workerCapacity,
        generation: observed.policy.generation + 1,
        updatedAt: atIso(checkedNow(now)),
      };
      const updated = await store.compareAndSet(
        ref,
        observed.record.version,
        policyRecordBody(candidate),
      );
      if (updated) return { updated: true, policy: copyPolicy(candidate) };

      const current = await readPolicySnapshot(input.repository);
      if (!current) return { updated: false, reason: "not-found" };
      return {
        updated: false,
        reason:
          current.policy.generation === input.expectedGeneration
            ? "contended"
            : "generation-mismatch",
        policy: copyPolicy(current.policy),
      };
    },
  };
}

/**
 * Git/GitHub-backed coordination adapter. Records are commits containing one
 * JSON file, addressed by reserved remote refs. Every ref mutation uses the
 * exact observed object ID through `git push --force-with-lease=<ref>:<oid>`.
 */
export function createCoordinationPort(
  workflowRoot: string,
  options: CoordinationPortOptions = {},
): CoordinationPort {
  return createCoordinationPortFromStore(
    createGitRecordStore(workflowRoot, options.remoteName ?? "origin"),
    options,
  );
}

/** Create a deterministic in-memory CoordinationPort for races, expiry, and fencing tests. */
export function createInMemoryCoordinationPort(
  options: InMemoryCoordinationPortOptions = {},
): CoordinationPort {
  return createCoordinationPortFromStore(
    options.store ?? new InMemoryCoordinationStore(),
    options,
  );
}

/** Alias emphasizing that this port is intended for deterministic test fakes. */
export const createFakeCoordinationPort = createInMemoryCoordinationPort;

/** Convenience factory for one store shared by several fake CoordinationPorts. */
export function createInMemoryCoordinationStore(): InMemoryCoordinationStore {
  return new InMemoryCoordinationStore();
}
