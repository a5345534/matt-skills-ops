/**
 * Pure launch rules for Implementation worker slots and P1 priority.
 *
 * Normative:
 *   N = effective concurrency (>= 1)
 *   running = count of Implementation workers with status "running"
 *   slots = max(0, N - running)
 *
 * Do not launch new Implementation workers when:
 *   - slots === 0, or
 *   - pendingDisposition is set, or
 *   - pendingIntegration / Conflict worker is active, or
 *   - no ready-frontier ticket remains
 *
 * P1: already-running workers are not aborted when another ticket hits
 * needs-disposition; new implements wait until disposition/integration finishes.
 */

/** Count Implementation workers whose status is `running`. */
export function countRunningImplementationWorkers(
  workers: readonly { status: string }[],
): number {
  let count = 0;
  for (const worker of workers) {
    if (worker.status === "running") count += 1;
  }
  return count;
}

/**
 * Free Implementation slots given effective concurrency N and running count.
 * Never negative. Callers pass already-resolved N (>= 1).
 */
export function computeImplementationSlots(
  effectiveConcurrency: number,
  runningCount: number,
): number {
  const n =
    typeof effectiveConcurrency === "number" &&
    Number.isFinite(effectiveConcurrency)
      ? Math.floor(effectiveConcurrency)
      : 0;
  const running =
    typeof runningCount === "number" && Number.isFinite(runningCount)
      ? Math.max(0, Math.floor(runningCount))
      : 0;
  return Math.max(0, n - running);
}

/** Why a new Implementation worker must not launch (P1 + slot math). */
export type ImplementationLaunchBlockReason =
  | "pending-disposition"
  | "pending-integration"
  | "conflict-worker"
  | "no-slots"
  | "empty-frontier";

/**
 * Decide whether a new Implementation launch is allowed.
 * Returns the first blocking reason, or `undefined` when launch is allowed.
 * Order matches product P1: disposition/integration/conflict before slots.
 */
export function implementationLaunchBlockReason(input: {
  slots: number;
  pendingDisposition: boolean;
  pendingIntegration: boolean;
  activeConflictWorker: boolean;
  readyCount: number;
}): ImplementationLaunchBlockReason | undefined {
  if (input.pendingDisposition) return "pending-disposition";
  if (input.pendingIntegration) return "pending-integration";
  if (input.activeConflictWorker) return "conflict-worker";
  if (input.slots <= 0) return "no-slots";
  if (input.readyCount <= 0) return "empty-frontier";
  return undefined;
}

/** True when slot math and P1 allow opening a new Implementation worker. */
export function canLaunchImplementationWorker(input: {
  slots: number;
  pendingDisposition: boolean;
  pendingIntegration: boolean;
  activeConflictWorker: boolean;
  readyCount: number;
}): boolean {
  return implementationLaunchBlockReason(input) === undefined;
}
