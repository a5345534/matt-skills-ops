import type { WorkerSlotLease } from "./types.js";

/** One workflow's currently schedulable ready-ticket queue. */
export type RepositoryWorkerDemand = {
  workflowId: number;
  /** Ready ticket numbers in the workflow's deterministic ready order. */
  readyTicketNumbers: readonly number[];
};

/** A live worker-slot lease occupying repository-wide Implementation capacity. */
export type OccupiedRepositoryWorkerSlot = {
  slot: number;
  workflowId: number;
  ticketNumber?: number;
};

/** One fair assignment for a currently free worker slot. */
export type RepositoryWorkerSlotAssignment = {
  slot: number;
  workflowId: number;
  ticketNumber: number;
};

/** A ready-first ticket that may claim the next free slot without jumping a share. */
export type RepositoryWorkerSlotClaim = {
  workflowId: number;
  ticketNumber: number;
};

/** Snapshot-derived allocation plan; callers still acquire each lease conditionally. */
export type RepositoryWorkerSlotPlan = {
  capacity: number;
  occupied: readonly OccupiedRepositoryWorkerSlot[];
  freeSlots: readonly number[];
  /** Deterministic full round-robin projection for diagnostics/planning. */
  assignments: readonly RepositoryWorkerSlotAssignment[];
  /**
   * First tickets allowed to claim the next free slot. Equal-share workflows
   * may race for it; the conditional slot lease resolves that race without
   * making capacity idle merely because a lower-ID home has not asked yet.
   */
  claimable: readonly RepositoryWorkerSlotClaim[];
};

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalizeTicketNumbers(numbers: readonly number[]): number[] {
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const number of numbers) {
    if (!positiveInteger(number) || seen.has(number)) continue;
    seen.add(number);
    normalized.push(number);
  }
  return normalized;
}

/**
 * A worker-slot lease consumes capacity only while it is both unreleased and
 * unexpired. CoordinationPort still returns tombstones/expired records so the
 * scheduler must make this distinction itself.
 */
export function isLiveWorkerSlotLease(
  lease: WorkerSlotLease,
  nowMs: number = Date.now(),
): boolean {
  if (lease.releasedAt !== undefined) return false;
  const expiresAtMs = Date.parse(lease.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

/**
 * Compute a deterministic, max-min fair plan for currently free repository
 * worker slots. Existing live leases are never reassigned: they count toward
 * their workflow's share, while free slots go first to workflows with fewer
 * live slots. Ties use Workflow ID, yielding a stable round-robin order.
 *
 * Ticket selection is deliberately inside each workflow's sorted ready queue.
 * A ticket already named by a live lease is excluded so a stale frontier cannot
 * schedule the same ticket twice.
 */
export function planRepositoryWorkerSlots(input: {
  capacity: number;
  occupied: readonly OccupiedRepositoryWorkerSlot[];
  demands: readonly RepositoryWorkerDemand[];
}): RepositoryWorkerSlotPlan {
  const capacity = positiveInteger(input.capacity) ? input.capacity : 0;

  // A well-formed CoordinationPort permits one lease per numbered slot. Be
  // defensive at this pure boundary anyway: retain the first stable record for
  // duplicate slot observations instead of double-counting capacity.
  const bySlot = new Map<number, OccupiedRepositoryWorkerSlot>();
  for (const raw of [...input.occupied].sort((left, right) => left.slot - right.slot)) {
    if (!positiveInteger(raw.slot) || !positiveInteger(raw.workflowId)) continue;
    if (bySlot.has(raw.slot)) continue;
    bySlot.set(raw.slot, {
      slot: raw.slot,
      workflowId: raw.workflowId,
      ...(positiveInteger(raw.ticketNumber)
        ? { ticketNumber: raw.ticketNumber }
        : {}),
    });
  }
  const occupied = [...bySlot.values()].sort((left, right) => left.slot - right.slot);

  const assignedTickets = new Map<number, Set<number>>();
  const allocationCounts = new Map<number, number>();
  for (const slot of occupied) {
    allocationCounts.set(
      slot.workflowId,
      (allocationCounts.get(slot.workflowId) ?? 0) + 1,
    );
    if (slot.ticketNumber !== undefined) {
      const tickets = assignedTickets.get(slot.workflowId) ?? new Set<number>();
      tickets.add(slot.ticketNumber);
      assignedTickets.set(slot.workflowId, tickets);
    }
  }

  // Merge duplicate demand rows defensively; discovery should produce one row
  // per workflow, but a pure scheduler should never make duplicate rows unfair.
  const queues = new Map<number, number[]>();
  for (const demand of input.demands) {
    if (!positiveInteger(demand.workflowId)) continue;
    const heldTickets = assignedTickets.get(demand.workflowId) ?? new Set<number>();
    const next = normalizeTicketNumbers(demand.readyTicketNumbers).filter(
      (ticketNumber) => !heldTickets.has(ticketNumber),
    );
    const queue = queues.get(demand.workflowId) ?? [];
    queue.push(...next);
    queues.set(demand.workflowId, normalizeTicketNumbers(queue));
  }

  const freeSlots: number[] = [];
  for (let slot = 1; slot <= capacity; slot += 1) {
    if (!bySlot.has(slot)) freeSlots.push(slot);
  }

  const claimable: RepositoryWorkerSlotClaim[] =
    freeSlots.length === 0
      ? []
      : (() => {
          const candidates = [...queues.entries()]
            .filter(([, queue]) => queue.length > 0)
            .map(([workflowId, queue]) => ({
              workflowId,
              ticketNumber: queue[0]!,
              allocationCount: allocationCounts.get(workflowId) ?? 0,
            }));
          const minimum = Math.min(
            ...candidates.map((candidate) => candidate.allocationCount),
          );
          return candidates
            .filter((candidate) => candidate.allocationCount === minimum)
            .sort((left, right) => left.workflowId - right.workflowId)
            .map(({ workflowId, ticketNumber }) => ({
              workflowId,
              ticketNumber,
            }));
        })();

  const assignments: RepositoryWorkerSlotAssignment[] = [];
  for (const slot of freeSlots) {
    const candidates = [...queues.entries()]
      .filter(([, queue]) => queue.length > 0)
      .map(([workflowId, queue]) => ({
        workflowId,
        queue,
        allocationCount: allocationCounts.get(workflowId) ?? 0,
      }));
    if (candidates.length === 0) break;

    candidates.sort(
      (left, right) =>
        left.allocationCount - right.allocationCount ||
        left.workflowId - right.workflowId,
    );
    const winner = candidates[0]!;
    const ticketNumber = winner.queue.shift();
    if (ticketNumber === undefined) continue;
    assignments.push({ slot, workflowId: winner.workflowId, ticketNumber });
    allocationCounts.set(winner.workflowId, winner.allocationCount + 1);
  }

  return {
    capacity,
    occupied,
    freeSlots,
    assignments,
    claimable,
  };
}
