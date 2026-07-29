import type {
  ImplementationDispositionDecision,
  NextAction,
  SpecDraft,
  StageConfirmationDecision,
  StageId,
  StageResult,
  TicketsDraft,
  WorkflowCoordinator,
} from "../types.js";

/**
 * The interaction seam between coordinator-owned actions and a visible surface.
 *
 * The coordinator remains the only owner of workflow and remote state. This
 * module only turns coordinator Stage results into explicit prompts, receives
 * a decision through an adapter, and serializes one dashboard action at a
 * time. A blocking select menu and a persistent dashboard therefore share the
 * same action semantics without either surface calling tracker adapters.
 */

/** A reviewable Planning-stage confirmation presented to an operator. */
export type StageConfirmationPrompt =
  | {
      kind: "stage-confirmation";
      stage: "create-spec";
      draft: SpecDraft;
      choices: readonly StageConfirmationDecision[];
    }
  | {
      kind: "stage-confirmation";
      stage: "create-tickets";
      draft: TicketsDraft;
      choices: readonly StageConfirmationDecision[];
    };

/** A completed Implementation attempt awaiting an explicit disposition. */
export type ImplementationDispositionPrompt = {
  kind: "implementation-disposition";
  ticketNumber: number;
  attempt: number;
  branchName: string;
  worktreePath?: string;
  workerId?: string;
  summary?: string;
  choices: readonly ImplementationDispositionDecision[];
};

/** One operator prompt emitted while a Next action resolves. */
export type WorkflowActionPrompt =
  | StageConfirmationPrompt
  | ImplementationDispositionPrompt;

/** A decision accepted by one of the prompt kinds. */
export type WorkflowActionDecision =
  | StageConfirmationDecision
  | ImplementationDispositionDecision;

/**
 * Deep interaction interface used by manual action execution. Implementations
 * decide how a prompt stays visible; they never invoke coordinator mutations.
 */
export type WorkflowActionInteraction = {
  present(
    prompt: WorkflowActionPrompt,
  ): Promise<WorkflowActionDecision | undefined>;
};

/** Minimal blocking-select surface used by the fallback adapter. */
export type FallbackWorkflowActionUi = {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
};

/** A labeled choice suitable for an inline dashboard action row. */
export type DashboardActionChoice = {
  value: WorkflowActionDecision;
  label: string;
};

/** Pure inline copy for a pending dashboard confirmation/disposition. */
export type DashboardActionPromptView = {
  title: string;
  lines: readonly string[];
  choices: readonly DashboardActionChoice[];
};

/** Visual severity for a settled action result. */
export type DashboardActionResultTone = "info" | "warning" | "error";

/**
 * Pure inline presentation of a coordinator Stage result. The `action` field
 * is deliberately explicit so a dashboard can show recoverable next steps
 * rather than hiding a failed or compatibility-recovery result in chat.
 */
export type DashboardActionResultView = {
  result: StageResult;
  tone: DashboardActionResultTone;
  title: string;
  lines: readonly string[];
  action: string;
};

/** Label a stored decision without tying row identity to rendered text. */
export function workflowActionChoiceLabel(
  decision: WorkflowActionDecision,
): string {
  switch (decision) {
    case "publish":
      return "Publish";
    case "revise":
      return "Revise";
    case "cancel":
      return "Cancel";
    case "close":
      return "Close (start Integration)";
    case "leave-open":
      return "Leave open";
    case "investigate":
      return "Investigate";
  }
}

/** Build pure inline content for a confirmation or disposition prompt. */
export function buildDashboardActionPromptView(
  prompt: WorkflowActionPrompt,
): DashboardActionPromptView {
  const choices = prompt.choices.map((value) => ({
    value,
    label: workflowActionChoiceLabel(value),
  }));

  if (prompt.kind === "implementation-disposition") {
    const lines = [
      `Branch: ${prompt.branchName}`,
      ...(prompt.summary ? [`Summary: ${prompt.summary}`] : []),
      "Close starts Integration later and does not close the tracker ticket yet.",
    ];
    if (prompt.worktreePath) {
      lines.splice(1, 0, `Worktree: ${prompt.worktreePath}`);
    }
    if (prompt.workerId) {
      lines.splice(1, 0, `Worker: ${prompt.workerId}`);
    }
    return {
      title: `Implementation disposition · #${prompt.ticketNumber} r${prompt.attempt}`,
      lines,
      choices,
    };
  }

  if (prompt.stage === "create-spec") {
    const preview = previewSpecDraft(prompt.draft);
    return {
      title: "Stage confirmation · Create-spec",
      lines: [
        `Title: ${prompt.draft.title}`,
        ...(preview ? ["Preview:", preview] : []),
      ],
      choices,
    };
  }

  return {
    title: "Stage confirmation · Create-tickets",
    lines: prompt.draft.tickets.map((ticket) => {
      const blockers =
        ticket.blockedBy.length === 0 ? "none" : ticket.blockedBy.join(", ");
      return `• [${ticket.localId}] ${ticket.title} (blocked by: ${blockers})`;
    }),
    choices,
  };
}

/** Convert a result view to render-ready lines without a TUI dependency. */
export function dashboardActionResultLines(
  view: DashboardActionResultView,
): readonly string[] {
  return [view.title, ...view.lines, `Next: ${view.action}`];
}

/** Build inline result copy for every Stage result status. */
export function buildDashboardActionResultView(
  result: StageResult,
): DashboardActionResultView {
  switch (result.status) {
    case "completed": {
      const lines = [`Stage: ${stageLabel(result.stage)}`];
      if (typeof result.workflowId === "number") {
        lines.push(`Workflow: #${result.workflowId}`);
      }
      if (typeof result.ticketNumber === "number") {
        lines.push(`Ticket: #${result.ticketNumber}`);
      }
      if (typeof result.attempt === "number") {
        lines.push(`Attempt: r${result.attempt}`);
      }
      if (result.integrationBranch) {
        lines.push(`Integration branch: ${result.integrationBranch}`);
      }
      if (result.ciSummary) {
        lines.push(`CI: ${result.ciSummary}`);
      }
      return {
        result,
        tone: "info",
        title: `${stageLabel(result.stage)} completed`,
        lines,
        action: "Inspect the refreshed Next actions before choosing the next operation.",
      };
    }
    case "failed":
      return {
        result,
        tone: "error",
        title: `${stageLabel(result.stage)} failed`,
        lines: [
          `Reason: ${result.reason}`,
          ...(typeof result.ticketNumber === "number"
            ? [`Ticket: #${result.ticketNumber}`]
            : []),
        ],
        action:
          "Correct the reported problem, then choose an explicit Next action to retry safely.",
      };
    case "cancelled":
      return {
        result,
        tone: "warning",
        title: `${stageLabel(result.stage)} cancelled`,
        lines: [
          "The action stopped at an explicit cancellation boundary.",
        ],
        action:
          "Choose a Next action when ready; Matt Auto did not advance automatically.",
      };
    case "compatibility-recovery":
      return {
        result,
        tone: "warning",
        title: "Compatibility recovery",
        lines: [
          `Stage: ${stageLabel(result.stage)}`,
          `Reason: ${result.reason}`,
        ],
        action:
          "Inspect the draft or Worker transcript, then choose an explicit recovery action; Matt Auto will not infer a transition.",
      };
    case "needs-confirmation":
      return {
        result,
        tone: "warning",
        title: "Stage confirmation still required",
        lines: [`Stage: ${stageLabel(result.stage)}`],
        action: "Choose Publish, Revise, or Cancel explicitly.",
      };
    case "needs-disposition":
      return {
        result,
        tone: "warning",
        title: `Implementation #${result.ticketNumber} needs disposition`,
        lines: [
          `Attempt: r${result.attempt}`,
          ...(result.summary ? [`Summary: ${result.summary}`] : []),
        ],
        action: "Choose Close, Leave open, or Investigate explicitly.",
      };
    case "running":
      return {
        result,
        tone: "info",
        title: `${stageLabel(result.stage)} running`,
        lines: [
          ...(result.stage === "target-refresh"
            ? [
                `Target branch: ${result.targetBranch}`,
                `Integration branch: ${result.integrationBranch}`,
                ...(result.targetSha
                  ? [`Target SHA: ${result.targetSha.slice(0, 12)}`]
                  : []),
              ]
            : [`Ticket: #${result.ticketNumber}`]),
          `Attempt: r${result.attempt}`,
          ...(result.stage === "implement"
            ? [`Worktree: ${result.worktreePath}`]
            : []),
        ],
        action:
          result.stage === "target-refresh"
            ? "Watch Target-refresh / Conflict resolution telemetry; the Target-branch lease is held until verification and PR update complete."
            : "Watch the Worker telemetry; a disposition appears after Implementation completes.",
      };
    case "pending-ci":
      return {
        result,
        tone: "info",
        title: `CI pending for #${result.ticketNumber}`,
        lines: [
          `Integration branch: ${result.integrationBranch}`,
          ...(result.ciSummary ? [`CI: ${result.ciSummary}`] : []),
          ...(result.ciUrl ? [`CI URL: ${result.ciUrl}`] : []),
        ],
        action: "Use Check CI when ready; Matt Auto does not background-poll CI.",
      };
    case "needs-ci-recovery":
      return {
        result,
        tone: "warning",
        title: `CI recovery needed for #${result.ticketNumber}`,
        lines: [
          `Integration branch: ${result.integrationBranch}`,
          ...(result.ciSummary ? [`CI: ${result.ciSummary}`] : []),
          ...(result.ciUrl ? [`CI URL: ${result.ciUrl}`] : []),
        ],
        action: "Choose Inspect, Retry, or Leave open explicitly.",
      };
  }
}

/**
 * Fallback adapter for hosts without a persistent custom surface. It preserves
 * the established nested `ui.select()` interaction while sharing the same
 * prompt objects used by the dashboard adapter.
 */
export function createFallbackWorkflowActionInteraction(
  ui: FallbackWorkflowActionUi,
): WorkflowActionInteraction {
  return {
    async present(prompt) {
      ui.notify(fallbackPromptMessage(prompt), "info");
      const selected = await ui.select(
        prompt.kind === "stage-confirmation"
          ? "Stage confirmation"
          : "Implementation disposition",
        prompt.choices.map(workflowActionChoiceLabel),
      );
      if (selected === undefined) return undefined;
      return prompt.choices.find(
        (choice) =>
          selected === choice || selected === workflowActionChoiceLabel(choice),
      );
    },
  };
}

/**
 * Dashboard adapter: stores one pending prompt for the dashboard owner to
 * render inline. Calling `choose` or `cancel` settles the waiting action but
 * never closes the surrounding custom surface or invokes the coordinator.
 */
export class DashboardWorkflowActionInteraction
  implements WorkflowActionInteraction
{
  private pendingPrompt: WorkflowActionPrompt | undefined;
  private pendingResolver:
    | ((decision: WorkflowActionDecision | undefined) => void)
    | undefined;
  private readonly listeners = new Set<() => void>();

  /** Current inline confirmation/disposition, if an action is waiting. */
  get pending(): WorkflowActionPrompt | undefined {
    return this.pendingPrompt;
  }

  /** Whether the dashboard should render confirmation choices. */
  get hasPendingPrompt(): boolean {
    return this.pendingPrompt !== undefined;
  }

  /** Subscribe a dashboard renderer to pending-prompt changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  present(
    prompt: WorkflowActionPrompt,
  ): Promise<WorkflowActionDecision | undefined> {
    if (this.pendingPrompt) {
      return Promise.reject(
        new Error("A dashboard action confirmation is already pending."),
      );
    }

    return new Promise((resolve) => {
      this.pendingPrompt = prompt;
      this.pendingResolver = resolve;
      this.emit();
    });
  }

  /** Apply one visible inline choice. Returns false for stale/invalid input. */
  choose(decision: WorkflowActionDecision): boolean {
    const prompt = this.pendingPrompt;
    if (!prompt || !promptAcceptsDecision(prompt, decision)) return false;
    this.settle(decision);
    return true;
  }

  /**
   * Explicitly dismiss a visible prompt without closing the dashboard surface.
   * A Stage-confirmation dismissal follows the fallback cancel path; dashboard
   * Esc should be handled by its owner, not bound to this method.
   */
  cancel(): boolean {
    if (!this.pendingPrompt) return false;
    this.settle(undefined);
    return true;
  }

  private settle(decision: WorkflowActionDecision | undefined): void {
    const resolve = this.pendingResolver;
    this.pendingPrompt = undefined;
    this.pendingResolver = undefined;
    this.emit();
    resolve?.(decision);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Rendering callbacks must not strand a coordinator action.
      }
    }
  }
}

/** Coordinator methods required by the shared manual-action executor. */
export type WorkflowActionCoordinator = Pick<
  WorkflowCoordinator,
  "runNextAction" | "confirmStage" | "confirmDisposition"
>;

/** Optional automation behavior retained for `/matt-auto run`. */
export type WorkflowActionExecutionOptions = {
  interaction: WorkflowActionInteraction;
  /** Auto-Publish Planning stages and Auto-Close Implementation dispositions. */
  autoAdvance?: boolean;
  /** Presentation-only callback for auto decisions (for example fallback chat). */
  onAutomaticDecision?: (
    prompt: WorkflowActionPrompt,
    decision: WorkflowActionDecision,
  ) => void;
};

/**
 * Execute one coordinator-owned Next action and resolve only its explicit
 * confirmation/disposition boundaries through the supplied interaction seam.
 */
export async function executeWorkflowAction(
  coordinator: WorkflowActionCoordinator,
  action: NextAction,
  options: WorkflowActionExecutionOptions,
): Promise<StageResult> {
  const initial = await coordinator.runNextAction(action.id);
  return resolveWorkflowActionResult(coordinator, initial, options);
}

/** Resolve confirmation and disposition results without selecting a UI surface. */
export async function resolveWorkflowActionResult(
  coordinator: WorkflowActionCoordinator,
  initial: StageResult,
  options: WorkflowActionExecutionOptions,
): Promise<StageResult> {
  let result = initial;

  while (result.status === "needs-confirmation") {
    const prompt = stageConfirmationPrompt(result);
    const decision = await decidePrompt(prompt, options);
    if (
      !isStageConfirmationDecision(decision) ||
      !prompt.choices.includes(decision)
    ) {
      // Esc / a stale choice preserves the established fail-closed cancel path.
      result = await coordinator.confirmStage("cancel");
      break;
    }
    result = await coordinator.confirmStage(decision);
  }

  if (result.status !== "needs-disposition") return result;

  const prompt = implementationDispositionPrompt(result);
  const decision = await decidePrompt(prompt, options);
  if (
    !isImplementationDispositionDecision(decision) ||
    !prompt.choices.includes(decision)
  ) {
    // A dismissed disposition deliberately remains pending for a later action.
    return result;
  }
  return coordinator.confirmDisposition(decision);
}

/** Dashboard execution states exposed to a persistent renderer. */
export type DashboardActionPhase =
  | "idle"
  | "executing"
  | "awaiting-choice"
  | "refreshing"
  | "settled"
  | "error";

/** Immutable snapshot read by the dashboard owner on each render. */
export type DashboardActionState = {
  phase: DashboardActionPhase;
  /** True from invocation through post-settlement refresh. */
  inputDisabled: boolean;
  refreshing: boolean;
  busyActionId?: string;
  prompt?: WorkflowActionPrompt;
  result?: DashboardActionResultView;
  /** Unexpected execution or refresh failure, kept inline for recovery. */
  error?: string;
};

/** Result of a dashboard action invocation (never throws for action failures). */
export type DashboardActionRunOutcome =
  | {
      kind: "busy";
      busyActionId: string;
    }
  | {
      kind: "settled";
      result: StageResult;
      refreshed: boolean;
      refreshError?: string;
    }
  | {
      kind: "error";
      error: string;
      refreshed: boolean;
      refreshError?: string;
    };

/** Configuration owned by the dashboard presentation module. */
export type DashboardActionControllerOptions = {
  /** Rebuild the dashboard snapshot after every action settlement. */
  refresh: () => Promise<void> | void;
  /** Inject a deterministic adapter in tests or a shared dashboard surface. */
  interaction?: DashboardWorkflowActionInteraction;
  /** Convenience subscription for TUI `requestRender()`. */
  onStateChange?: () => void;
};

/**
 * Serialize dashboard action execution behind a small presentation interface.
 * The owner renders `getState()` and calls `choose` only from an explicit
 * action row; passive inspection has no path to coordinator mutation.
 */
export class DashboardWorkflowActionController {
  readonly interaction: DashboardWorkflowActionInteraction;

  private readonly refreshDashboard: () => Promise<void> | void;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeInteraction: () => void;
  private inFlight: Promise<DashboardActionRunOutcome> | undefined;
  private busyActionId: string | undefined;
  private phase: DashboardActionPhase = "idle";
  private refreshing = false;
  private result: DashboardActionResultView | undefined;
  private error: string | undefined;

  constructor(
    private readonly coordinator: WorkflowActionCoordinator,
    options: DashboardActionControllerOptions,
  ) {
    this.refreshDashboard = options.refresh;
    this.interaction =
      options.interaction ?? new DashboardWorkflowActionInteraction();
    this.unsubscribeInteraction = this.interaction.subscribe(() => {
      if (this.busyActionId) {
        this.phase = this.interaction.pending
          ? "awaiting-choice"
          : "executing";
      }
      this.emit();
    });
    if (options.onStateChange) {
      this.subscribe(options.onStateChange);
    }
  }

  /** Current render state; reading it has no coordinator side effects. */
  getState(): DashboardActionState {
    return {
      phase: this.phase,
      inputDisabled: this.busyActionId !== undefined,
      refreshing: this.refreshing,
      ...(this.busyActionId ? { busyActionId: this.busyActionId } : {}),
      ...(this.interaction.pending ? { prompt: this.interaction.pending } : {}),
      ...(this.result ? { result: this.result } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Subscribe a custom component to busy/prompt/result/refresh transitions. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Start one explicit action; concurrent invocations are ignored fail-closed. */
  run(action: NextAction): Promise<DashboardActionRunOutcome> {
    // `busyActionId` is assigned before the first render notification, so it
    // also guards a synchronous re-entrant input callback before `inFlight`
    // receives the newly-created promise.
    if (this.inFlight || this.busyActionId) {
      return Promise.resolve({
        kind: "busy",
        busyActionId: this.busyActionId ?? action.id,
      });
    }

    this.busyActionId = action.id;
    this.phase = "executing";
    this.refreshing = false;
    this.result = undefined;
    this.error = undefined;
    this.emit();

    const execution = this.runAction(action);
    this.inFlight = execution;
    return execution;
  }

  /** Forward one explicit inline choice to the dashboard interaction adapter. */
  choose(decision: WorkflowActionDecision): boolean {
    return this.interaction.choose(decision);
  }

  /**
   * Explicitly dismiss the currently visible prompt. For a Stage confirmation
   * this follows the fallback cancel path; dashboard-level Esc must not call it.
   */
  cancelPrompt(): boolean {
    return this.interaction.cancel();
  }

  /** Clear a settled inline result; busy actions intentionally keep it visible. */
  dismissResult(): boolean {
    if (this.busyActionId) return false;
    if (!this.result && !this.error) return false;
    this.result = undefined;
    this.error = undefined;
    this.phase = "idle";
    this.emit();
    return true;
  }

  /**
   * Release render subscriptions only when no action is in flight. A dashboard
   * must keep its visible surface open while this returns false; its inline
   * Cancel choice, not Esc, owns any Stage-confirmation cancellation.
   */
  dispose(): boolean {
    if (this.busyActionId) return false;
    this.unsubscribeInteraction();
    this.listeners.clear();
    return true;
  }

  private async runAction(action: NextAction): Promise<DashboardActionRunOutcome> {
    let settledResult: StageResult | undefined;
    let executionError: string | undefined;
    let refreshError: string | undefined;

    try {
      settledResult = await executeWorkflowAction(this.coordinator, action, {
        interaction: this.interaction,
      });
      this.result = buildDashboardActionResultView(settledResult);
    } catch (error) {
      executionError = errorMessage(error);
      this.error = [
        `Action execution failed: ${executionError}`,
        "Review the error, then choose an explicit Next action to retry safely.",
      ].join(" ");
    }

    this.phase = "refreshing";
    this.refreshing = true;
    this.emit();

    try {
      await this.refreshDashboard();
    } catch (error) {
      refreshError = errorMessage(error);
      const refreshMessage = `Dashboard refresh failed: ${refreshError}`;
      this.error = executionError
        ? `${this.error ?? `Action execution failed: ${executionError}`} ${refreshMessage}`
        : refreshMessage;
    } finally {
      this.busyActionId = undefined;
      this.refreshing = false;
      this.phase = executionError || refreshError ? "error" : "settled";
      this.inFlight = undefined;
      this.emit();
    }

    if (settledResult) {
      return {
        kind: "settled",
        result: settledResult,
        refreshed: refreshError === undefined,
        ...(refreshError ? { refreshError } : {}),
      };
    }

    return {
      kind: "error",
      error: executionError ?? "Unknown dashboard action failure.",
      refreshed: refreshError === undefined,
      ...(refreshError ? { refreshError } : {}),
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A rendering callback must never change action semantics.
      }
    }
  }
}

function stageConfirmationPrompt(
  result: Extract<StageResult, { status: "needs-confirmation" }>,
): StageConfirmationPrompt {
  if (result.stage === "create-spec") {
    return {
      kind: "stage-confirmation",
      stage: "create-spec",
      draft: result.draft,
      choices: result.confirmationOptions,
    };
  }
  return {
    kind: "stage-confirmation",
    stage: "create-tickets",
    draft: result.draft,
    choices: result.confirmationOptions,
  };
}

function implementationDispositionPrompt(
  result: Extract<StageResult, { status: "needs-disposition" }>,
): ImplementationDispositionPrompt {
  return {
    kind: "implementation-disposition",
    ticketNumber: result.ticketNumber,
    attempt: result.attempt,
    branchName: result.branchName,
    worktreePath: result.worktreePath,
    workerId: result.workerId,
    ...(result.summary ? { summary: result.summary } : {}),
    choices: result.dispositionOptions,
  };
}

async function decidePrompt(
  prompt: WorkflowActionPrompt,
  options: WorkflowActionExecutionOptions,
): Promise<WorkflowActionDecision | undefined> {
  if (!options.autoAdvance) {
    return options.interaction.present(prompt);
  }

  const decision: WorkflowActionDecision =
    prompt.kind === "stage-confirmation" ? "publish" : "close";
  options.onAutomaticDecision?.(prompt, decision);
  return decision;
}

function promptAcceptsDecision(
  prompt: WorkflowActionPrompt,
  decision: WorkflowActionDecision,
): boolean {
  return (prompt.choices as readonly WorkflowActionDecision[]).includes(decision);
}

function isStageConfirmationDecision(
  decision: WorkflowActionDecision | undefined,
): decision is StageConfirmationDecision {
  return (
    decision === "publish" || decision === "revise" || decision === "cancel"
  );
}

function isImplementationDispositionDecision(
  decision: WorkflowActionDecision | undefined,
): decision is ImplementationDispositionDecision {
  return (
    decision === "close" ||
    decision === "leave-open" ||
    decision === "investigate"
  );
}

function fallbackPromptMessage(prompt: WorkflowActionPrompt): string {
  if (prompt.kind === "implementation-disposition") {
    const summary = prompt.summary ? `\n${prompt.summary}` : "";
    return `Implementation disposition for #${prompt.ticketNumber} (r${prompt.attempt}) on ${prompt.branchName}.${summary}\nClose starts Integration later and does not close the tracker ticket yet.`;
  }

  if (prompt.stage === "create-spec") {
    return `Stage confirmation for Create-spec\nTitle: ${prompt.draft.title}\n\n${previewSpecDraft(prompt.draft)}`;
  }

  const lines = prompt.draft.tickets.map((ticket) => {
    const blockers =
      ticket.blockedBy.length === 0 ? "none" : ticket.blockedBy.join(", ");
    return `• [${ticket.localId}] ${ticket.title} (blocked by: ${blockers})`;
  });
  return `Stage confirmation for Create-tickets\n${lines.join("\n")}`;
}

function previewSpecDraft(draft: SpecDraft): string {
  return draft.body.length > 280 ? `${draft.body.slice(0, 277)}...` : draft.body;
}

function stageLabel(stage: StageId): string {
  switch (stage) {
    case "create-spec":
      return "Create-spec";
    case "create-tickets":
      return "Create-tickets";
    case "implement":
      return "Implementation";
    case "integrate":
      return "Integration";
    case "ci-gate":
      return "CI gate";
    case "workflow-pr":
      return "Workflow PR";
    case "target-refresh":
      return "Target-branch refresh";
    case "cleanup":
      return "Workflow cleanup";
    case "rework":
      return "Rework";
    case "follow-up":
      return "Follow-up workflow";
    case "workflow-routing":
      return "Workflow-home routing";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
