import { describe, expect, it, vi } from "vitest";
import {
  dispositionActionId,
  implementTicketActionId,
  integrateTicketActionId,
} from "../src/constants.js";
import {
  runPostGrillPipeline,
  type MattAutoUi,
} from "../src/ui/menu.js";
import type {
  NextAction,
  PreflightResult,
  StageResult,
  WorkflowCoordinator,
  WorkflowPanelState,
} from "../src/types.js";

const okPreflight: PreflightResult = {
  ok: true,
  targetBranch: "main",
  checks: [
    {
      id: "github-remote",
      ok: true,
      guidance: "ok",
    },
  ],
};

function mockUi(): MattAutoUi & { notices: string[]; selects: number } {
  const notices: string[] = [];
  return {
    notices,
    selects: 0,
    select: async () => {
      // Pipeline should auto-pick; never require a human choice in these tests.
      throw new Error("unexpected ui.select in auto-advance pipeline test");
    },
    notify: (message) => {
      notices.push(message);
    },
  };
}

type FakeWorker = {
  ticketNumber: number;
  status: "running" | "needs-disposition";
  workerId: string;
  attempt: number;
  branchName: string;
  worktreePath: string;
};

/**
 * Minimal multi-worker run-loop fake: N slots, ready frontier, one pending
 * disposition at a time, serial Integration units. Enough to exercise
 * fill-then-wait + P1 disposition ordering without the full coordinator.
 */
function createRunLoopFake(options: {
  concurrency: number;
  ready: number[];
  /** Tick schedule for worker completions after wait begins (by ticket). */
  completeOnWaitTick?: Record<number, number>;
}) {
  const ready = [...options.ready].sort((a, b) => a - b);
  /** Tickets already finished (disposed / integrated) — never re-launch. */
  const finished = new Set<number>();
  const workers = new Map<number, FakeWorker>();
  let pendingDisposition: number | undefined;
  let pendingIntegration: number | undefined;
  let integrationInFlight = false;
  let waitTicks = 0;
  const launches: number[] = [];
  const dispositions: number[] = [];
  const integrations: number[] = [];
  const waitCalls: Array<{
    running: number[];
    needsDisposition: number[];
    pendingIntegration?: number;
  }> = [];

  function panel(): WorkflowPanelState {
    const listed: Array<WorkflowPanelState["workers"][number]> = [];
    for (const w of [...workers.values()].sort(
      (a, b) => a.ticketNumber - b.ticketNumber,
    )) {
      listed.push({
        ticketNumber: w.ticketNumber,
        attempt: w.attempt,
        status: w.status,
        workerId: w.workerId,
        branchName: w.branchName,
        worktreePath: w.worktreePath,
        processAlive: w.status === "running",
      });
    }
    if (pendingDisposition !== undefined && !workers.has(pendingDisposition)) {
      listed.push({
        ticketNumber: pendingDisposition,
        attempt: 1,
        status: "needs-disposition",
        workerId: `implement-42-${pendingDisposition}-r1`,
        branchName: `matt-auto/42/ticket-${pendingDisposition}/r1`,
        worktreePath: `/ws/${pendingDisposition}`,
      });
    }
    const state: WorkflowPanelState = {
      workflowId: 42,
      title: "Run loop fake",
      lines: [`Workflow #42`],
      workers: listed,
      pipelinePaused: false,
    };
    if (pendingIntegration !== undefined) {
      state.integration = {
        ticketNumber: pendingIntegration,
        attempt: 1,
        status: "pending-retry",
        branchName: `matt-auto/42/ticket-${pendingIntegration}/r1`,
      };
    }
    return state;
  }

  function runningTickets(): number[] {
    return [...workers.values()]
      .filter((w) => w.status === "running")
      .map((w) => w.ticketNumber)
      .sort((a, b) => a - b);
  }

  function freeSlots(): number {
    return Math.max(0, options.concurrency - runningTickets().length);
  }

  function nextActions(): NextAction[] {
    // P1: disposition, then Integration, then fill implements.
    if (pendingDisposition !== undefined) {
      return [
        {
          id: dispositionActionId(pendingDisposition),
          label: `Disposition #${pendingDisposition}`,
          description: "Auto-Close path",
        },
      ];
    }
    if (pendingIntegration !== undefined) {
      return [
        {
          id: integrateTicketActionId(pendingIntegration),
          label: `Retry Integration #${pendingIntegration}`,
          description: "Serial Integration unit",
        },
      ];
    }
    if (integrationInFlight) {
      // No concurrent Integration / implement fills while Integration runs.
      return [];
    }
    const slots = freeSlots();
    if (slots <= 0) return [];
    const launchable = ready.filter(
      (n) => !workers.has(n) && !finished.has(n) && pendingDisposition !== n,
    );
    return launchable.slice(0, slots).map((n) => ({
      id: implementTicketActionId(n),
      label: `Implement #${n}`,
      description: `Ready #${n}`,
    }));
  }

  async function runNextAction(actionId: string): Promise<StageResult> {
    if (actionId.startsWith("implement-ticket:")) {
      const ticketNumber = Number(actionId.slice("implement-ticket:".length));
      if (pendingDisposition !== undefined || pendingIntegration !== undefined) {
        return {
          status: "failed",
          stage: "implement",
          reason: "P1 blocks new implements",
          ticketNumber,
        };
      }
      if (freeSlots() <= 0) {
        return {
          status: "failed",
          stage: "implement",
          reason: "No free Implementation worker slots",
          ticketNumber,
        };
      }
      if (
        workers.has(ticketNumber) ||
        finished.has(ticketNumber) ||
        !ready.includes(ticketNumber)
      ) {
        return {
          status: "failed",
          stage: "implement",
          reason: "Not launchable",
          ticketNumber,
        };
      }
      const worker: FakeWorker = {
        ticketNumber,
        status: "running",
        workerId: `implement-42-${ticketNumber}-r1`,
        attempt: 1,
        branchName: `matt-auto/42/ticket-${ticketNumber}/r1`,
        worktreePath: `/ws/${ticketNumber}`,
      };
      workers.set(ticketNumber, worker);
      launches.push(ticketNumber);
      return {
        status: "running",
        stage: "implement",
        workflowId: 42,
        ticketNumber,
        attempt: 1,
        workerId: worker.workerId,
        branchName: worker.branchName,
        worktreePath: worker.worktreePath,
      };
    }

    if (actionId.startsWith("disposition:")) {
      const ticketNumber = Number(actionId.slice("disposition:".length));
      if (pendingDisposition !== ticketNumber) {
        return {
          status: "failed",
          stage: "implement",
          reason: "No pending disposition",
          ticketNumber,
        };
      }
      return {
        status: "needs-disposition",
        stage: "implement",
        workflowId: 42,
        ticketNumber,
        attempt: 1,
        branchName: `matt-auto/42/ticket-${ticketNumber}/r1`,
        worktreePath: `/ws/${ticketNumber}`,
        workerId: `implement-42-${ticketNumber}-r1`,
        dispositionOptions: ["close", "leave-open", "investigate"],
      };
    }

    if (actionId.startsWith("integrate-ticket:")) {
      const ticketNumber = Number(actionId.slice("integrate-ticket:".length));
      if (pendingIntegration !== ticketNumber) {
        return {
          status: "failed",
          stage: "integrate",
          reason: "No pending Integration",
          ticketNumber,
        };
      }
      if (integrationInFlight) {
        return {
          status: "failed",
          stage: "integrate",
          reason: "Integration unit already in flight",
          ticketNumber,
        };
      }
      // Serial Integration completes immediately in the fake.
      integrations.push(ticketNumber);
      pendingIntegration = undefined;
      return {
        status: "completed",
        stage: "integrate",
        workflowId: 42,
        ticketNumber,
        attempt: 1,
      };
    }

    return {
      status: "failed",
      stage: "create-spec",
      reason: `Unknown action ${actionId}`,
    };
  }

  async function confirmDisposition(
    decision: "close" | "leave-open" | "investigate",
  ): Promise<StageResult> {
    if (pendingDisposition === undefined) {
      return {
        status: "failed",
        stage: "implement",
        reason: "No pending disposition",
      };
    }
    const ticketNumber = pendingDisposition;
    dispositions.push(ticketNumber);
    pendingDisposition = undefined;
    workers.delete(ticketNumber);
    finished.add(ticketNumber);
    // Promote next needs-disposition worker if any.
    for (const w of workers.values()) {
      if (w.status === "needs-disposition") {
        pendingDisposition = w.ticketNumber;
        workers.delete(w.ticketNumber);
        break;
      }
    }
    if (decision === "close") {
      // Start serial Integration unit; never allow a second concurrent unit.
      if (pendingIntegration !== undefined || integrationInFlight) {
        return {
          status: "failed",
          stage: "integrate",
          reason: "An Integration unit is already pending",
          ticketNumber,
        };
      }
      // Successful Integration unit (no concurrent second unit).
      integrationInFlight = true;
      integrations.push(ticketNumber);
      integrationInFlight = false;
      return {
        status: "completed",
        stage: "integrate",
        workflowId: 42,
        ticketNumber,
        attempt: 1,
        disposition: "close",
        integrated: true,
        branchName: `matt-auto/42/ticket-${ticketNumber}/r1`,
        worktreePath: `/ws/${ticketNumber}`,
      };
    }
    return {
      status: "completed",
      stage: "implement",
      workflowId: 42,
      ticketNumber,
      attempt: 1,
      disposition: decision,
      integrated: false,
      branchName: `matt-auto/42/ticket-${ticketNumber}/r1`,
      worktreePath: `/ws/${ticketNumber}`,
    };
  }

  /**
   * Advance scripted completions only while the pipeline would wait:
   * slots full (or no further ready launches) and no P1 work yet.
   * Avoids completing workers during fill-time getPanelState logging.
   */
  async function getPanelState(): Promise<WorkflowPanelState> {
    const schedule = options.completeOnWaitTick ?? {};
    const running = runningTickets();
    const launchableLeft = ready.filter(
      (n) => !workers.has(n) && !finished.has(n),
    ).length;
    const wouldWait =
      running.length > 0 &&
      pendingDisposition === undefined &&
      pendingIntegration === undefined &&
      !integrationInFlight &&
      (freeSlots() === 0 || launchableLeft === 0);

    if (wouldWait) {
      waitTicks += 1;
      waitCalls.push({
        running: [...running],
        needsDisposition: [],
        ...(pendingIntegration !== undefined
          ? { pendingIntegration }
          : {}),
      });
      for (const ticket of running) {
        const at = schedule[ticket];
        // Unscheduled workers complete on the first wait tick they are observed
        // so the pipeline can drain; scheduled ones wait for their tick.
        if (at !== undefined && waitTicks < at) continue;
        const worker = workers.get(ticket);
        if (!worker || worker.status !== "running") continue;
        if (pendingDisposition === undefined) {
          pendingDisposition = ticket;
          workers.delete(ticket);
        } else {
          worker.status = "needs-disposition";
        }
      }
    }
    return panel();
  }

  const coordinator = {
    beginPipelineRun: () => {
      waitTicks = 0;
    },
    isRunTerminated: () => false,
    isPipelinePaused: () => false,
    isAutoAdvanceBlocked: () => false,
    preflight: async () => okPreflight,
    nextActions: async () => nextActions(),
    getPanelState,
    runNextAction,
    confirmDisposition,
    confirmStage: async () => {
      throw new Error("unexpected confirmStage");
    },
    // Unused control APIs — wait settles without them when workers drain.
  } as unknown as WorkflowCoordinator;

  return {
    coordinator,
    state: {
      launches,
      dispositions,
      integrations,
      waitCalls,
      workers,
      get pendingDisposition() {
        return pendingDisposition;
      },
      get freeSlots() {
        return freeSlots();
      },
      runningTickets,
    },
  };
}

describe("runPostGrillPipeline fill slots then wait", () => {
  it("opens min(N, readyCount) workers without waiting for the first to finish", async () => {
    const { coordinator, state } = createRunLoopFake({
      concurrency: 2,
      ready: [43, 44, 46],
      // First completion after slots are full and wait has started.
      completeOnWaitTick: { 43: 1, 44: 2 },
    });
    const ui = mockUi();

    await runPostGrillPipeline(coordinator, ui);

    // Filled both slots before any wait drained a worker.
    expect(state.launches.slice(0, 2)).toEqual([43, 44]);
    // After disposition+integration of #43, free slot fills #46.
    expect(state.launches).toEqual([43, 44, 46]);
    // Never launched a 4th overflow beyond the frontier.
    expect(state.launches).toHaveLength(3);
  });

  it("processes disposition (P1) before filling a free slot while a peer still runs", async () => {
    const { coordinator, state } = createRunLoopFake({
      concurrency: 2,
      ready: [43, 44, 46],
      // #43 completes on first wait tick; #44 stays running until later.
      completeOnWaitTick: { 43: 1, 44: 5 },
    });
    const ui = mockUi();

    await runPostGrillPipeline(coordinator, ui);

    // Multi-launch first.
    expect(state.launches[0]).toBe(43);
    expect(state.launches[1]).toBe(44);

    // Disposition for #43 before launching #46.
    const firstDispositionAt = state.dispositions.indexOf(43);
    expect(firstDispositionAt).toBe(0);
    const launch46At = state.launches.indexOf(46);
    expect(launch46At).toBeGreaterThan(1);
    // Integration for #43 is serial and happened (auto-Close).
    expect(state.integrations).toContain(43);
    // Ordering: disposition #43 recorded before #46 was launched.
    // (launches array already has 43,44 before 46; dispositions[0] is 43)
    expect(state.dispositions[0]).toBe(43);
    expect(state.launches.indexOf(46)).toBe(2);
  });

  it("never starts a second Integration unit concurrently", async () => {
    const { coordinator, state } = createRunLoopFake({
      concurrency: 2,
      ready: [43, 44],
      completeOnWaitTick: { 43: 1, 44: 1 },
    });
    const ui = mockUi();
    const integrateSpy = vi.fn();

    // Wrap confirmDisposition to assert no overlapping Integration.
    const original = coordinator.confirmDisposition.bind(coordinator);
    let integrationDepth = 0;
    let maxDepth = 0;
    coordinator.confirmDisposition = async (decision) => {
      integrationDepth += 1;
      maxDepth = Math.max(maxDepth, integrationDepth);
      try {
        const result = await original(decision);
        if (result.status === "completed" && "integrated" in result) {
          integrateSpy(result.ticketNumber);
        }
        return result;
      } finally {
        integrationDepth -= 1;
      }
    };

    await runPostGrillPipeline(coordinator, ui);

    expect(maxDepth).toBe(1);
    expect(state.integrations).toEqual([43, 44]);
    expect(new Set(state.integrations).size).toBe(state.integrations.length);
  });

  it("waits when slots are full instead of offering overflow implements", async () => {
    const { coordinator, state } = createRunLoopFake({
      concurrency: 2,
      ready: [43, 44, 46],
      completeOnWaitTick: { 43: 2, 44: 3 },
    });
    const ui = mockUi();

    await runPostGrillPipeline(coordinator, ui);

    // After the first two launches, a wait must have observed both running
    // before any third launch (slots full).
    const preThirdWaits = state.waitCalls.filter(
      (c) =>
        c.running.includes(43) &&
        c.running.includes(44) &&
        !state.launches.slice(2).length,
    );
    // At least one wait snapshot saw both 43 and 44 running with no third launch yet.
    // (waitCalls accumulate for the whole run; check early snapshots.)
    const early = state.waitCalls.find(
      (c) => c.running.length === 2 && c.running.includes(43) && c.running.includes(44),
    );
    expect(early).toBeDefined();
    expect(state.launches[0]).toBe(43);
    expect(state.launches[1]).toBe(44);
    // Third only after a slot frees via disposition path.
    expect(state.launches[2]).toBe(46);
    expect(preThirdWaits.length + (early ? 1 : 0)).toBeGreaterThan(0);
  });
});
