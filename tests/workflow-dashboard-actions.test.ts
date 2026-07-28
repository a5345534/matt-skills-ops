import { describe, expect, it, vi } from "vitest";
import type {
  NextAction,
  StageResult,
} from "../src/types.js";
import {
  buildDashboardActionPromptView,
  buildDashboardActionResultView,
  createFallbackWorkflowActionInteraction,
  dashboardActionResultLines,
  DashboardWorkflowActionController,
  DashboardWorkflowActionInteraction,
  executeWorkflowAction,
  type WorkflowActionCoordinator,
} from "../src/ui/workflow-dashboard-actions.js";

const createSpecAction: NextAction = {
  id: "create-spec",
  label: "Create spec",
  description: "Create a reviewable spec draft.",
};

const anotherAction: NextAction = {
  id: "create-tickets",
  label: "Create tickets",
  description: "Create reviewable ticket drafts.",
};

function specDraft() {
  return {
    title: "Dashboard interaction seam",
    body: "A reviewable draft for an explicit Publish, Revise, or Cancel choice.",
  };
}

function needsConfirmation(): Extract<
  StageResult,
  { status: "needs-confirmation" }
> {
  return {
    status: "needs-confirmation",
    stage: "create-spec",
    draft: specDraft(),
    confirmationOptions: ["publish", "revise", "cancel"],
  };
}

function needsDisposition(): Extract<
  StageResult,
  { status: "needs-disposition" }
> {
  return {
    status: "needs-disposition",
    stage: "implement",
    workflowId: 42,
    ticketNumber: 43,
    attempt: 1,
    branchName: "matt-auto/42/ticket-43/r1",
    worktreePath: "/workspaces/42/ticket-43/r1",
    workerId: "implement-42-43-r1",
    summary: "Committed dashboard interaction work.",
    dispositionOptions: ["close", "leave-open", "investigate"],
  };
}

function completed(): Extract<StageResult, { status: "completed" }> {
  return {
    status: "completed",
    stage: "create-spec",
    workflowId: 42,
  };
}

function coordinatorFor(
  runNextAction: () => Promise<StageResult>,
  confirmStage: (decision: "publish" | "revise" | "cancel") => Promise<StageResult> =
    async () => completed(),
  confirmDisposition: (
    decision: "close" | "leave-open" | "investigate",
  ) => Promise<StageResult> = async () => completed(),
): WorkflowActionCoordinator {
  return {
    runNextAction: async () => runNextAction(),
    confirmStage,
    confirmDisposition,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("workflow action interaction adapters", () => {
  it("keeps the existing blocking-select confirmation and disposition fallback", async () => {
    const selects: Array<{ title: string; options: string[] }> = [];
    const notices: string[] = [];
    const fallback = createFallbackWorkflowActionInteraction({
      select: async (title, options) => {
        selects.push({ title, options: [...options] });
        return title === "Stage confirmation" ? "Publish" : "Investigate";
      },
      notify: (message) => {
        notices.push(message);
      },
    });

    const confirmation = await fallback.present({
      kind: "stage-confirmation",
      stage: "create-spec",
      draft: specDraft(),
      choices: ["publish", "revise", "cancel"],
    });
    const disposition = await fallback.present({
      kind: "implementation-disposition",
      ticketNumber: 43,
      attempt: 1,
      branchName: "matt-auto/42/ticket-43/r1",
      choices: ["close", "leave-open", "investigate"],
    });

    expect(confirmation).toBe("publish");
    expect(disposition).toBe("investigate");
    expect(selects).toEqual([
      {
        title: "Stage confirmation",
        options: ["Publish", "Revise", "Cancel"],
      },
      {
        title: "Implementation disposition",
        options: ["Close (start Integration)", "Leave open", "Investigate"],
      },
    ]);
    expect(notices[0]).toMatch(/Stage confirmation for Create-spec/);
    expect(notices[1]).toMatch(/Implementation disposition for #43/);
  });

  it("uses fallback choices to drive coordinator confirmation exactly as before", async () => {
    const confirmStage = vi.fn(async () => completed());
    const coordinator = coordinatorFor(async () => needsConfirmation(), confirmStage);
    const result = await executeWorkflowAction(coordinator, createSpecAction, {
      interaction: createFallbackWorkflowActionInteraction({
        select: async () => "Publish",
        notify: () => {},
      }),
    });

    expect(confirmStage).toHaveBeenCalledTimes(1);
    expect(confirmStage).toHaveBeenCalledWith("publish");
    expect(result).toEqual(completed());
  });

  it("keeps dashboard confirmation state inline until an explicit choice", async () => {
    const adapter = new DashboardWorkflowActionInteraction();
    const changes = vi.fn();
    adapter.subscribe(changes);
    const prompt = {
      kind: "stage-confirmation" as const,
      stage: "create-spec" as const,
      draft: specDraft(),
      choices: ["publish", "revise", "cancel"] as const,
    };

    const decision = adapter.present(prompt);
    expect(adapter.pending).toEqual(prompt);
    expect(buildDashboardActionPromptView(prompt)).toMatchObject({
      title: "Stage confirmation · Create-spec",
      choices: [
        { value: "publish", label: "Publish" },
        { value: "revise", label: "Revise" },
        { value: "cancel", label: "Cancel" },
      ],
    });
    expect(adapter.choose("close")).toBe(false);
    expect(adapter.choose("publish")).toBe(true);
    await expect(decision).resolves.toBe("publish");
    expect(adapter.pending).toBeUndefined();
    expect(changes).toHaveBeenCalledTimes(2);

    const dispositionPrompt = {
      kind: "implementation-disposition" as const,
      ticketNumber: 43,
      attempt: 1,
      branchName: "matt-auto/42/ticket-43/r1",
      choices: ["close", "leave-open", "investigate"] as const,
    };
    const disposition = adapter.present(dispositionPrompt);
    expect(buildDashboardActionPromptView(dispositionPrompt).choices).toEqual([
      { value: "close", label: "Close (start Integration)" },
      { value: "leave-open", label: "Leave open" },
      { value: "investigate", label: "Investigate" },
    ]);
    expect(adapter.choose("investigate")).toBe(true);
    await expect(disposition).resolves.toBe("investigate");

    const dismissed = adapter.present(prompt);
    expect(adapter.cancel()).toBe(true);
    await expect(dismissed).resolves.toBeUndefined();
    expect(adapter.pending).toBeUndefined();
  });

  it("drives an inline Implementation disposition only after its explicit choice", async () => {
    const confirmDisposition = vi.fn(async () => completed());
    const adapter = new DashboardWorkflowActionInteraction();
    const resultPromise = executeWorkflowAction(
      coordinatorFor(
        async () => needsDisposition(),
        async () => completed(),
        confirmDisposition,
      ),
      createSpecAction,
      { interaction: adapter },
    );

    await vi.waitFor(() => {
      expect(adapter.pending).toMatchObject({
        kind: "implementation-disposition",
        ticketNumber: 43,
      });
    });
    expect(confirmDisposition).not.toHaveBeenCalled();
    expect(adapter.choose("close")).toBe(true);
    await expect(resultPromise).resolves.toEqual(completed());
    expect(confirmDisposition).toHaveBeenCalledWith("close");
  });
});

describe("DashboardWorkflowActionController", () => {
  it("waits for an explicit inline confirmation, then refreshes the dashboard", async () => {
    const confirmStage = vi.fn(async () => completed());
    const refresh = vi.fn(async () => {});
    const controller = new DashboardWorkflowActionController(
      coordinatorFor(async () => needsConfirmation(), confirmStage),
      { refresh },
    );
    const phases: string[] = [];
    controller.subscribe(() => {
      phases.push(controller.getState().phase);
    });

    const outcomePromise = controller.run(createSpecAction);
    await vi.waitFor(() => {
      expect(controller.getState().phase).toBe("awaiting-choice");
    });
    expect(controller.getState()).toMatchObject({
      inputDisabled: true,
      busyActionId: "create-spec",
      prompt: { kind: "stage-confirmation", stage: "create-spec" },
    });
    expect(confirmStage).not.toHaveBeenCalled();
    // Dashboard Esc must not turn an in-flight prompt into a coordinator cancel.
    expect(controller.dispose()).toBe(false);
    expect(confirmStage).not.toHaveBeenCalled();

    expect(controller.choose("publish")).toBe(true);
    const outcome = await outcomePromise;

    expect(outcome).toMatchObject({ kind: "settled", refreshed: true });
    expect(confirmStage).toHaveBeenCalledWith("publish");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({
      phase: "settled",
      inputDisabled: false,
      result: {
        title: "Create-spec completed",
        tone: "info",
      },
    });
    expect(phases).toContain("awaiting-choice");
    expect(phases).toContain("refreshing");
    expect(controller.dispose()).toBe(true);
  });

  it("prevents duplicate actions through execution and refresh, then settles inline", async () => {
    const actionDeferred = deferred<StageResult>();
    const refreshDeferred = deferred<void>();
    const runNextAction = vi.fn(() => actionDeferred.promise);
    const refresh = vi.fn(() => refreshDeferred.promise);
    const controller = new DashboardWorkflowActionController(
      coordinatorFor(runNextAction),
      { refresh },
    );

    const first = controller.run(createSpecAction);
    await vi.waitFor(() => {
      expect(runNextAction).toHaveBeenCalledTimes(1);
    });
    await expect(controller.run(anotherAction)).resolves.toEqual({
      kind: "busy",
      busyActionId: "create-spec",
    });
    expect(runNextAction).toHaveBeenCalledTimes(1);

    actionDeferred.resolve(completed());
    await vi.waitFor(() => {
      expect(controller.getState()).toMatchObject({
        phase: "refreshing",
        inputDisabled: true,
        refreshing: true,
      });
    });
    await expect(controller.run(anotherAction)).resolves.toEqual({
      kind: "busy",
      busyActionId: "create-spec",
    });

    refreshDeferred.resolve();
    await expect(first).resolves.toMatchObject({
      kind: "settled",
      refreshed: true,
    });
    expect(controller.getState()).toMatchObject({
      phase: "settled",
      inputDisabled: false,
      refreshing: false,
    });
  });

  it("blocks a synchronous re-entrant action from a dashboard render callback", async () => {
    const actionDeferred = deferred<StageResult>();
    const runNextAction = vi.fn(() => actionDeferred.promise);
    const controller = new DashboardWorkflowActionController(
      coordinatorFor(runNextAction),
      { refresh: async () => {} },
    );
    let reentrant: ReturnType<typeof controller.run> | undefined;
    controller.subscribe(() => {
      const state = controller.getState();
      if (!reentrant && state.busyActionId === "create-spec") {
        reentrant = controller.run(anotherAction);
      }
    });

    const first = controller.run(createSpecAction);
    await vi.waitFor(() => {
      expect(reentrant).toBeDefined();
      expect(runNextAction).toHaveBeenCalledTimes(1);
    });
    await expect(reentrant).resolves.toEqual({
      kind: "busy",
      busyActionId: "create-spec",
    });

    actionDeferred.resolve(completed());
    await expect(first).resolves.toMatchObject({ kind: "settled" });
  });

  it("keeps execution and refresh errors inline while still attempting refresh", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("snapshot unavailable");
    });
    const controller = new DashboardWorkflowActionController(
      coordinatorFor(async () => {
        throw new Error("coordinator unavailable");
      }),
      { refresh },
    );

    const outcome = await controller.run(createSpecAction);

    expect(outcome).toEqual({
      kind: "error",
      error: "coordinator unavailable",
      refreshed: false,
      refreshError: "snapshot unavailable",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    const state = controller.getState();
    expect(state).toMatchObject({
      phase: "error",
      inputDisabled: false,
    });
    expect(state.error).toContain("Action execution failed: coordinator unavailable");
    expect(state.error).toContain("Dashboard refresh failed: snapshot unavailable");
  });
});

describe("dashboard Stage-result presentation", () => {
  it.each([
    [
      completed(),
      "Create-spec completed",
      "Inspect the refreshed Next actions",
    ],
    [
      {
        status: "failed",
        stage: "implement",
        reason: "Local verification failed",
        ticketNumber: 43,
      } satisfies StageResult,
      "Implementation failed",
      "Correct the reported problem",
    ],
    [
      { status: "cancelled", stage: "create-spec" } satisfies StageResult,
      "Create-spec cancelled",
      "did not advance automatically",
    ],
    [
      {
        status: "compatibility-recovery",
        stage: "implement",
        reason: "Worker omitted a Stage result",
        ticketNumber: 43,
      } satisfies StageResult,
      "Compatibility recovery",
      "will not infer a transition",
    ],
  ])("renders %s inline with actionable detail", (result, title, action) => {
    const view = buildDashboardActionResultView(result);
    const lines = dashboardActionResultLines(view).join("\n");

    expect(view.title).toBe(title);
    expect(view.action).toContain(action);
    expect(lines).toContain(`Next: ${view.action}`);
  });
});
