import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  COORDINATION_REF_PREFIX,
  coordinationLeaseRefName,
  createCoordinationPort,
  createFakeCoordinationPort,
  createInMemoryCoordinationStore,
  workerCapacityPolicyRefName,
} from "../src/adapters/coordination.js";
import type { CoordinationLease } from "../src/types.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

const repository = { owner: "Acme", name: "workflow-tools" };
const target = {
  repository,
  targetRef: "refs/heads/main",
};

type TestClock = {
  now: () => Date;
  advance: (milliseconds: number) => void;
};

function createClock(initial = "2026-07-28T16:00:00.000Z"): TestClock {
  let milliseconds = Date.parse(initial);
  return {
    now: () => new Date(milliseconds),
    advance: (amount) => {
      milliseconds += amount;
    },
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout;
}

async function createGitCoordinationRoots(): Promise<{
  first: string;
  second: string;
}> {
  const root = await temporaryDirectory("matt-auto-coordination-git-");
  const remote = path.join(root, "remote.git");
  await runGit(root, ["init", "--bare", remote]);

  const roots: string[] = [];
  for (const name of ["first", "second"]) {
    const worktree = path.join(root, name);
    await mkdir(worktree);
    await runGit(worktree, ["init"]);
    await runGit(worktree, ["remote", "add", "origin", remote]);
    roots.push(worktree);
  }
  const [first, second] = roots;
  if (!first || !second) throw new Error("Could not create test Git roots.");
  return { first, second };
}

function requireLease(
  result: { acquired: boolean; lease?: CoordinationLease },
): CoordinationLease {
  expect(result.acquired).toBe(true);
  if (!result.acquired || !result.lease) {
    throw new Error("Expected coordination lease acquisition to succeed.");
  }
  return result.lease;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe("deterministic fake CoordinationPort", () => {
  it("allows exactly one same-state contender and exposes complete lease facts", async () => {
    const clock = createClock();
    const store = createInMemoryCoordinationStore();
    const left = createFakeCoordinationPort({ store, now: clock.now });
    const right = createFakeCoordinationPort({ store, now: clock.now });
    const input = {
      kind: "workflow-coordinator" as const,
      repository,
      target,
      workflowId: 40,
      ttlMs: 1_000,
    };

    const [leftResult, rightResult] = await Promise.all([
      left.acquireLease({ ...input, holderId: "home-left" }),
      right.acquireLease({ ...input, holderId: "home-right" }),
    ]);

    const outcomes = [leftResult, rightResult];
    const acquired = outcomes.filter((outcome) => outcome.acquired);
    expect(acquired).toHaveLength(1);
    const winner = acquired[0];
    if (!winner || !winner.acquired) throw new Error("Missing race winner.");

    expect(winner.lease).toMatchObject({
      kind: "workflow-coordinator",
      scope: { repository, target, workflowId: 40 },
      generation: 1,
      heartbeatAt: "2026-07-28T16:00:00.000Z",
      expiresAt: "2026-07-28T16:00:01.000Z",
    });
    expect(["home-left", "home-right"]).toContain(winner.lease.holderId);

    const loser = outcomes.find((outcome) => !outcome.acquired);
    expect(loser).toMatchObject({ acquired: false, reason: "contended" });
    expect(loser && "lease" in loser ? loser.lease?.generation : undefined).toBe(1);
  });

  it("renews, reclaims expiry, rejects stale holders, and preserves monotonic fences through release", async () => {
    const clock = createClock();
    const store = createInMemoryCoordinationStore();
    const first = createFakeCoordinationPort({ store, now: clock.now });
    const second = createFakeCoordinationPort({ store, now: clock.now });
    const key = {
      kind: "target-branch" as const,
      target,
    };

    const initial = requireLease(
      await first.acquireLease({
        ...key,
        holderId: "first-home",
        workflowId: 40,
        ttlMs: 1_000,
      }),
    );
    clock.advance(500);
    const renewed = await first.renewLease({ lease: initial, ttlMs: 1_000 });
    expect(renewed.renewed).toBe(true);
    if (!renewed.renewed) throw new Error("Expected renewal to succeed.");
    expect(renewed.lease).toMatchObject({
      generation: 1,
      heartbeatAt: "2026-07-28T16:00:00.500Z",
      expiresAt: "2026-07-28T16:00:01.500Z",
    });

    clock.advance(1_001);
    const reclaimed = requireLease(
      await second.acquireLease({
        ...key,
        holderId: "second-home",
        workflowId: 41,
        ttlMs: 1_000,
      }),
    );
    expect(reclaimed).toMatchObject({
      generation: 2,
      holderId: "second-home",
      workflowId: 41,
    });

    await expect(first.verifyLease(initial)).resolves.toMatchObject({
      valid: false,
      reason: "lost",
    });
    await expect(first.renewLease({ lease: initial })).resolves.toMatchObject({
      renewed: false,
      reason: "lost",
    });
    await expect(first.releaseLease(initial)).resolves.toEqual({
      released: false,
      reason: "lost",
    });

    await expect(second.releaseLease(reclaimed)).resolves.toEqual({ released: true });
    const released = await first.getLease(key);
    expect(released).toMatchObject({
      generation: 2,
      holderId: "second-home",
    });
    expect(released?.releasedAt).toBe("2026-07-28T16:00:01.501Z");

    const afterRelease = requireLease(
      await first.acquireLease({
        ...key,
        holderId: "third-home",
        workflowId: 42,
      }),
    );
    expect(afterRelease.generation).toBe(3);
    await expect(second.verifyLease(reclaimed)).resolves.toMatchObject({
      valid: false,
      reason: "lost",
    });
  });

  it("models every lease kind and initializes a shared worker-capacity policy once", async () => {
    const clock = createClock();
    const store = createInMemoryCoordinationStore();
    const first = createFakeCoordinationPort({ store, now: clock.now });
    const second = createFakeCoordinationPort({ store, now: clock.now });

    const targetLease = requireLease(
      await first.acquireLease({
        kind: "target-branch",
        target,
        holderId: "target-holder",
        workflowId: 40,
      }),
    );
    const schedulerLease = requireLease(
      await first.acquireLease({
        kind: "repository-scheduler",
        repository,
        holderId: "scheduler-holder",
      }),
    );
    const workerSlotLease = requireLease(
      await first.acquireLease({
        kind: "worker-slot",
        repository,
        slot: 2,
        holderId: "worker-holder",
        workflowId: 40,
        ticketNumber: 400,
      }),
    );

    expect(targetLease.scope).toEqual({ target });
    expect(schedulerLease.scope).toEqual({ repository });
    expect(workerSlotLease).toMatchObject({
      scope: { repository, slot: 2 },
      workflowId: 40,
      ticketNumber: 400,
    });
    await expect(
      first.listLeases({ repository, kind: "worker-slot" }),
    ).resolves.toEqual([workerSlotLease]);

    const [firstInitialization, secondInitialization] = await Promise.all([
      first.ensureWorkerCapacityPolicy({ repository, seedWorkerCapacity: 2 }),
      second.ensureWorkerCapacityPolicy({ repository, seedWorkerCapacity: 7 }),
    ]);
    expect([firstInitialization.initialized, secondInitialization.initialized].filter(Boolean)).toHaveLength(1);
    expect(firstInitialization.policy).toEqual(secondInitialization.policy);
    expect(firstInitialization.policy.workerCapacity).toBeOneOf([2, 7]);

    const updated = await first.updateWorkerCapacityPolicy({
      repository,
      workerCapacity: 4,
      expectedGeneration: 1,
    });
    expect(updated).toMatchObject({
      updated: true,
      policy: { workerCapacity: 4, generation: 2 },
    });
    const stale = await second.updateWorkerCapacityPolicy({
      repository,
      workerCapacity: 5,
      expectedGeneration: 1,
    });
    expect(stale).toMatchObject({
      updated: false,
      reason: "generation-mismatch",
      policy: { workerCapacity: 4, generation: 2 },
    });
  });
});

describe("Git-backed CoordinationPort", () => {
  it("uses exact conditional remote refs for cross-checkout races, recovery, and policy reads", async () => {
    const { first: firstRoot, second: secondRoot } =
      await createGitCoordinationRoots();
    const clock = createClock();
    const first = createCoordinationPort(firstRoot, {
      now: clock.now,
      defaultLeaseTtlMs: 1_000,
    });
    const second = createCoordinationPort(secondRoot, {
      now: clock.now,
      defaultLeaseTtlMs: 1_000,
    });
    const key = {
      kind: "workflow-coordinator" as const,
      repository,
      target,
      workflowId: 40,
    };

    const [firstResult, secondResult] = await Promise.all([
      first.acquireLease({ ...key, holderId: "first-checkout" }),
      second.acquireLease({ ...key, holderId: "second-checkout" }),
    ]);
    expect([firstResult, secondResult].filter((result) => result.acquired)).toHaveLength(1);

    const winnerResult = firstResult.acquired ? firstResult : secondResult;
    const loserResult = firstResult.acquired ? secondResult : firstResult;
    const winnerPort = firstResult.acquired ? first : second;
    const loserPort = firstResult.acquired ? second : first;
    const winnerLease = requireLease(winnerResult);
    expect(loserResult).toMatchObject({ acquired: false, reason: "contended" });

    clock.advance(100);
    const renewal = await winnerPort.renewLease({ lease: winnerLease });
    expect(renewal.renewed).toBe(true);
    if (!renewal.renewed) throw new Error("Expected real lease renewal to succeed.");
    expect(renewal.lease).toMatchObject({
      generation: 1,
      heartbeatAt: "2026-07-28T16:00:00.100Z",
      expiresAt: "2026-07-28T16:00:01.100Z",
    });

    const ref = coordinationLeaseRefName(key);
    expect(ref.startsWith(COORDINATION_REF_PREFIX)).toBe(true);
    expect(await runGit(firstRoot, ["ls-remote", "--refs", "origin", ref])).toContain(ref);
    await expect(loserPort.getLease(key)).resolves.toEqual(renewal.lease);
    await expect(
      first.listLeases({ repository, kind: "workflow-coordinator" }),
    ).resolves.toEqual([renewal.lease]);

    // TTL expiry lets the other checkout reclaim only by replacing the exact
    // observed record. The first checkout cannot subsequently renew or release
    // the newer fence.
    clock.advance(1_001);
    const reclaimed = requireLease(
      await loserPort.acquireLease({ ...key, holderId: "reclaiming-checkout" }),
    );
    expect(reclaimed.generation).toBe(2);
    await expect(winnerPort.renewLease({ lease: renewal.lease })).resolves.toMatchObject({
      renewed: false,
      reason: "lost",
    });
    await expect(winnerPort.releaseLease(renewal.lease)).resolves.toEqual({
      released: false,
      reason: "lost",
    });
    await expect(loserPort.releaseLease(reclaimed)).resolves.toEqual({ released: true });
    const reacquired = requireLease(
      await winnerPort.acquireLease({ ...key, holderId: "third-checkout" }),
    );
    expect(reacquired.generation).toBe(3);

    // Use the same seed and injected clock: the two serialized policy records
    // would otherwise be byte-for-byte identical, so this verifies a no-op push
    // cannot masquerade as a second expected-absent conditional write.
    const [firstInitialization, secondInitialization] = await Promise.all([
      first.ensureWorkerCapacityPolicy({ repository, seedWorkerCapacity: 2 }),
      second.ensureWorkerCapacityPolicy({ repository, seedWorkerCapacity: 2 }),
    ]);
    expect(
      [firstInitialization.initialized, secondInitialization.initialized].filter(Boolean),
    ).toHaveLength(1);
    expect(firstInitialization.policy).toEqual(secondInitialization.policy);
    const initialized = firstInitialization.initialized
      ? firstInitialization
      : secondInitialization;
    const seenFromSecond = await second.ensureWorkerCapacityPolicy({
      repository,
      seedWorkerCapacity: 9,
    });
    expect(seenFromSecond).toEqual({
      initialized: false,
      policy: initialized.policy,
    });
    await expect(second.getWorkerCapacityPolicy(repository)).resolves.toEqual(
      initialized.policy,
    );
    const policyRef = workerCapacityPolicyRefName(repository);
    expect(
      await runGit(secondRoot, ["ls-remote", "--refs", "origin", policyRef]),
    ).toContain(policyRef);
  });
});
