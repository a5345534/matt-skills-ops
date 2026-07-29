/**
 * Matt Auto Pi extension — package shell for `/matt-auto` and `/matt-auto next`.
 *
 * Product rules live in the Workflow coordinator. This file wires Pi
 * commands/menus to coordinator ports and runs Planning skills in Workflow home.
 *
 * Planning stages invoke installed `/skill:to-spec` and `/skill:to-tickets`
 * (definitions untouched). Stage confirmation gates remote publication.
 * Implementation workers are session-owned and abort on session_shutdown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildCreateSpecSkillPrompt,
  buildCreateTicketsSkillPrompt,
  createCiPort,
  createCoordinationPort,
  createEnvironmentPort,
  createGitTopologyPort,
  createMattAutoLogger,
  createModelsPort,
  createPreferencesPort,
  createRemoteGitPort,
  createSessionLogger,
  createSkillsPort,
  createTrackerPort,
  createTranscriptPort,
  createVerificationPort,
  createWorkflowHomeLockPort,
  createWorkersPort,
  createWorkspacePort,
  findLatestDraftText,
  parseMarkedTicketsDraftFromTexts,
  validateLatestCreateSpecMarkdown,
  type MattAutoLogger,
  type SkillsHost,
} from "../src/adapters/index.js";
import {
  createWorkflowCoordinator,
  setCoordinatorLogger,
} from "../src/coordinator.js";
import {
  appendImplementationRoutingPolicy,
  isMattAutoWorkerProcess,
} from "../src/policy/implementation-routing.js";
import type { WorkflowCoordinator } from "../src/types.js";
import {
  presentMainMenu,
  presentNextActions,
  queuePipelineWaitControl,
  runControlFilePath,
  runPostGrillPipeline,
  setMenuLogger,
  writeRunControlFile,
  type MattAutoUi,
} from "../src/ui/menu.js";
import { clearWorkflowPanel } from "../src/ui/workflow-panel.js";

type PlanningSession = {
  sendUserMessage: (text: string) => void;
  waitForIdle: () => Promise<void>;
  /**
   * Snapshot the assistant-text stream length before sending a planning prompt.
   * Texts appended after this baseline belong to the current skill turn.
   */
  markAssistantBaseline: () => number;
  /** Assistant texts produced after markAssistantBaseline() (newest-last). */
  getAssistantTextsSince: (baseline: number) => string[];
};

const PLANNING_TURN_TIMEOUT_MS = 20 * 60 * 1000;
/** Only reuse recent marker-owned ticket drafts from the home session. */
const RECENT_DRAFT_WINDOW = 12;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * After sendUserMessage, wait until the home agent produces at least one new
 * assistant text (or timeout). A bare waitForIdle() returns immediately when
 * already idle — before the new turn starts — which caused empty Create-spec.
 */
async function waitForAssistantTextsSince(
  planning: PlanningSession,
  baseline: number,
  log: MattAutoLogger | undefined,
  label: string,
): Promise<string[]> {
  const started = Date.now();
  let polls = 0;
  while (Date.now() - started < PLANNING_TURN_TIMEOUT_MS) {
    polls += 1;
    // Let sendUserMessage schedule a turn before the first idle wait.
    await sleep(polls === 1 ? 150 : 250);
    await planning.waitForIdle();
    const texts = planning.getAssistantTextsSince(baseline);
    if (texts.length > 0) {
      // Settle once more so multi-part assistant messages finish streaming.
      await sleep(100);
      await planning.waitForIdle();
      const settled = planning.getAssistantTextsSince(baseline);
      log?.debug(`${label}:turn-settled`, {
        baseline,
        textCount: settled.length,
        polls,
        ms: Date.now() - started,
      });
      return settled;
    }
    if (polls === 1 || polls % 10 === 0) {
      log?.debug(`${label}:wait-empty`, {
        baseline,
        polls,
        ms: Date.now() - started,
      });
    }
  }
  log?.warn(`${label}:wait-timeout`, {
    baseline,
    polls,
    ms: Date.now() - started,
  });
  return planning.getAssistantTextsSince(baseline);
}

function extractAssistantText(message: {
  role?: string;
  content?: unknown;
}): string {
  if (message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part) {
        const block = part as { type?: string; text?: string };
        if (block.type === "text" && typeof block.text === "string") {
          return block.text;
        }
      }
      return "";
    })
    .join("");
}

function createSkillsHost(
  getUi: () => MattAutoUi | undefined,
  getPlanning: () => PlanningSession | undefined,
  getLog: () => MattAutoLogger | undefined,
): SkillsHost {
  // Only the first Create-spec invocation may reuse an intentional plain draft
  // already in the home session. Revisions always generate a fresh response.
  let hasInvokedCreateSpec = false;

  return {
    async runCreateSpec() {
      const ui = getUi();
      const planning = getPlanning();
      const log = getLog();
      if (!ui || !planning) {
        log?.error("runCreateSpec: host not ready");
        return {
          ok: false,
          reason:
            "Create-spec Planning host is not ready. Run `/matt-auto` from an interactive Workflow home session.",
        };
      }

      ui.notify(
        "Running installed /skill:to-spec in Workflow home (no tracker publish yet)…",
        "info",
      );
      log?.info("runCreateSpec:start");
      const started = Date.now();

      const prior = planning.getAssistantTextsSince(0);
      if (!hasInvokedCreateSpec) {
        const reused = validateLatestCreateSpecMarkdown(prior);
        if (reused.ok) {
          hasInvokedCreateSpec = true;
          log?.info("runCreateSpec:reused-session-plain-draft", {
            title: reused.draft.title,
            bodyChars: reused.draft.body.length,
            priorTextCount: prior.length,
            ms: Date.now() - started,
          });
          return { ok: true, draft: reused.draft };
        }
      }

      // Run to-spec and wait for a real agent turn — not a bare waitForIdle
      // while still idle. New responses must pass the plain-Markdown gate.
      hasInvokedCreateSpec = true;
      const baseline = planning.markAssistantBaseline();
      planning.sendUserMessage(buildCreateSpecSkillPrompt());
      const texts = await waitForAssistantTextsSince(
        planning,
        baseline,
        log,
        "runCreateSpec",
      );
      const response =
        [...texts].reverse().find((text) => text.trim().length > 0) ?? "";
      const validation = validateLatestCreateSpecMarkdown(texts);
      log?.debug("runCreateSpec:assistant", {
        textCount: texts.length,
        baseline,
        plainMarkdown: response.length > 0,
        qualityGate: validation.ok ? "passed" : "failed",
        ...(validation.ok ? {} : { issues: validation.issues }),
        ms: Date.now() - started,
      });
      if (!validation.ok) {
        log?.warn("runCreateSpec:quality-gate-failed", {
          issues: validation.issues,
          preview: response.slice(0, 300),
        });
        return {
          ok: false,
          reason:
            texts.length === 0
              ? "Create-spec did not receive any assistant reply after invoking to-spec (turn wait timed out or never started). Retry Create-spec or /matt-auto run. Nothing was published to the tracker."
              : [
                  "Create-spec quality gate rejected the assistant Markdown:",
                  validation.issues.join(" "),
                  "Retry Create-spec or /matt-auto run. Nothing was published to the tracker.",
                ].join(" "),
        };
      }
      const draft = validation.draft;
      log?.info("runCreateSpec:ok", {
        title: draft.title,
        bodyChars: draft.body.length,
        ms: Date.now() - started,
      });
      return { ok: true, draft };
    },

    async runCreateTickets(input) {
      const ui = getUi();
      const planning = getPlanning();
      const log = getLog();
      if (!ui || !planning) {
        log?.error("runCreateTickets: host not ready");
        return {
          ok: false,
          reason:
            "Create-tickets Planning host is not ready. Run `/matt-auto` from an interactive Workflow home session.",
        };
      }

      ui.notify(
        `Running installed /skill:to-tickets for Workflow #${input.workflowId} (no tracker publish yet)…`,
        "info",
      );
      log?.info("runCreateTickets:start", {
        workflowId: input.workflowId,
      });
      const started = Date.now();

      const prior = planning.getAssistantTextsSince(0);
      const reused = parseMarkedTicketsDraftFromTexts(prior, {
        recentWindow: RECENT_DRAFT_WINDOW,
      });
      if (reused) {
        log?.info("runCreateTickets:reused-session-draft", {
          workflowId: input.workflowId,
          ticketCount: reused.tickets.length,
          localIds: reused.tickets.map((t) => t.localId),
          ms: Date.now() - started,
        });
        return { ok: true, draft: reused };
      }

      const basePrompt = buildCreateTicketsSkillPrompt(input);
      const retryPrompt = [
        basePrompt,
        "",
        "## Retry (required)",
        "Your previous reply was missing the Matt Auto tickets draft markers.",
        "Output ONLY the ---MATT-AUTO-TICKETS-DRAFT--- JSON block this time — no PRD rewrite.",
      ].join("\n");

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const baseline = planning.markAssistantBaseline();
        planning.sendUserMessage(attempt === 1 ? basePrompt : retryPrompt);
        const texts = await waitForAssistantTextsSince(
          planning,
          baseline,
          log,
          "runCreateTickets",
        );
        const draft = parseMarkedTicketsDraftFromTexts(texts);
        log?.debug("runCreateTickets:assistant", {
          workflowId: input.workflowId,
          attempt,
          textCount: texts.length,
          baseline,
          hasMarker: Boolean(
            findLatestDraftText(texts, "---MATT-AUTO-TICKETS-DRAFT---"),
          ),
          ms: Date.now() - started,
        });
        if (draft) {
          log?.info("runCreateTickets:ok", {
            ticketCount: draft.tickets.length,
            localIds: draft.tickets.map((t) => t.localId),
            attempt,
            ms: Date.now() - started,
          });
          return { ok: true, draft };
        }
        log?.warn("runCreateTickets:parse-failed", {
          attempt,
          preview: (texts[texts.length - 1] ?? "").slice(0, 300),
        });
      }

      return {
        ok: false,
        reason:
          "Create-tickets finished but Matt Auto could not parse a valid ---MATT-AUTO-TICKETS-DRAFT--- JSON block after 2 attempts (markers required). Retry Create-tickets. Nothing was published to the tracker.",
      };
    },
  };
}

function uiFrom(ctx: {
  // Pi ExtensionUIContext is wider than MattAutoUi; pick methods we need.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ui: any;
}): MattAutoUi {
  const ui: MattAutoUi = {
    select: (title, options) => ctx.ui.select(title, options),
    notify: (message, type) => ctx.ui.notify(message, type),
  };
  if (ctx.ui.input) {
    const input = ctx.ui.input.bind(ctx.ui);
    ui.input = (title, placeholder) => input(title, placeholder);
  }
  if (ctx.ui.editor) {
    const editor = ctx.ui.editor.bind(ctx.ui);
    ui.editor = (title, prefill) => editor(title, prefill);
  }
  // Secondary compact Workflow panel (optional TUI widgets/status). Absent APIs → no-op.
  if (typeof ctx.ui.setWidget === "function") {
    const setWidget = ctx.ui.setWidget.bind(ctx.ui);
    ui.setWidget = (key, content, options) => setWidget(key, content, options);
  }
  if (typeof ctx.ui.setStatus === "function") {
    const setStatus = ctx.ui.setStatus.bind(ctx.ui);
    ui.setStatus = (key, text) => setStatus(key, text);
  }
  // Window/tab title for pi-ghostty-compatible busy spinner during worker waits.
  if (typeof ctx.ui.setTitle === "function") {
    const setTitle = ctx.ui.setTitle.bind(ctx.ui);
    ui.setTitle = (title) => setTitle(title);
  }
  // Live wait surface: brief refresh + selectable Pause/Terminate (Pi custom UI).
  if (typeof ctx.ui.custom === "function") {
    const custom = ctx.ui.custom.bind(ctx.ui) as NonNullable<MattAutoUi["custom"]>;
    ui.custom = custom;
  }
  return ui;
}

export default function mattAutoExtension(pi: ExtensionAPI) {
  const workers = createWorkersPort();
  let activeUi: MattAutoUi | undefined;
  let coordinator: WorkflowCoordinator | undefined;
  let boundCwd: string | undefined;
  let boundModelRegistry: Parameters<typeof createModelsPort>[0] | undefined;
  let logger: MattAutoLogger = createSessionLogger();
  let homeModelRef:
    | {
        provider: string;
        id: string;
        thinkingLevel: string;
        name?: string;
        reasoning?: boolean;
        thinkingLevelMap?: Record<string, string | null>;
      }
    | undefined;
  let planningSession: PlanningSession | undefined;
  /**
   * Esc dismissed a paused run back to chat. The coordinator is still alive,
   * but its foreground run loop returned; `/matt-auto resume` must restart it.
   */
  let pausedRunDismissed = false;
  const assistantTexts: string[] = [];

  const markPipelineStarted = () => {
    pausedRunDismissed = false;
  };
  const markPausedRunDismissed = () => {
    pausedRunDismissed = true;
  };

  const skillsHost = createSkillsHost(
    () => activeUi,
    () => planningSession,
    () => logger,
  );

  pi.on("message_end", async (event) => {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role === "assistant") {
      const text = extractAssistantText(message);
      if (text.trim()) {
        assistantTexts.push(text);
        // Cap memory for long sessions.
        if (assistantTexts.length > 50) assistantTexts.shift();
      }
    }
  });

  // Workflow home only: bias multi-ticket delivery toward /matt-auto without
  // editing Matt skill files. Workers skip via MATT_AUTO_ROLE.
  pi.on("before_agent_start", async (event) => {
    if (isMattAutoWorkerProcess()) return undefined;
    return {
      systemPrompt: appendImplementationRoutingPolicy(event.systemPrompt),
    };
  });

  // Make Matt Auto visible at session open (footer status), not only in system prompt.
  pi.on("session_start", async (_event, ctx) => {
    if (isMattAutoWorkerProcess()) return;
    try {
      ctx.ui.setStatus?.(
        "matt-auto",
        "Matt Auto · after grill/ADR offer /matt-auto run",
      );
    } catch {
      // status optional
    }
  });

  async function ensureCoordinator(
    cwd: string,
    modelRegistry: Parameters<typeof createModelsPort>[0],
    ui: MattAutoUi,
    homeModel: typeof homeModelRef,
  ): Promise<WorkflowCoordinator> {
    activeUi = ui;
    homeModelRef = homeModel;

    const sameSession =
      coordinator &&
      boundCwd === cwd &&
      boundModelRegistry === modelRegistry;
    if (sameSession && coordinator) {
      return coordinator;
    }

    if (coordinator) {
      await coordinator.abortWorkers();
      await coordinator.releaseWorkflowHome();
    }

    pausedRunDismissed = false;
    logger = createMattAutoLogger(cwd);
    setMenuLogger(logger);
    setCoordinatorLogger(logger);
    logger.info("coordinator:bind", { cwd });

    coordinator = createWorkflowCoordinator({
      startPath: cwd,
      topology: createGitTopologyPort(),
      models: createModelsPort(modelRegistry, () => homeModelRef),
      forRoot(rootPath) {
        return {
          environment: createEnvironmentPort(rootPath),
          skills: createSkillsPort(rootPath, skillsHost),
          preferences: createPreferencesPort(rootPath),
          tracker: createTrackerPort(rootPath),
          workspace: createWorkspacePort(rootPath),
          workers,
          transcripts: createTranscriptPort(rootPath),
          verification: createVerificationPort(),
          remoteGit: createRemoteGitPort(rootPath),
          ci: createCiPort(rootPath),
          coordination: createCoordinationPort(rootPath),
          workflowHomeLock: createWorkflowHomeLockPort(rootPath),
        };
      },
    });
    boundCwd = cwd;
    boundModelRegistry = modelRegistry;
    return coordinator;
  }

  pi.on("session_shutdown", async () => {
    if (coordinator) {
      await coordinator.abortWorkers();
      await coordinator.releaseWorkflowHome();
    }
    if (activeUi) {
      clearWorkflowPanel(activeUi);
    }
    coordinator = undefined;
    boundCwd = undefined;
    boundModelRegistry = undefined;
    activeUi = undefined;
    planningSession = undefined;
    pausedRunDismissed = false;
    assistantTexts.length = 0;
  });

  /**
   * Operator stop controls.
   *
   * Ctrl+Alt combos often never reach the TUI (terminal/OS eats Alt). Prefer
   * Ctrl+Shift+*. Handlers act immediately (notify + confirm + coordinator),
   * and also write the run-control file so the wait loop can observe the stop
   * even if the confirm path races with auto-wait polling.
   */
  async function requestPauseFromShortcut(
    ctx: { cwd: string; ui: { notify: MattAutoUi["notify"]; confirm?: (title: string, message: string) => Promise<boolean> } },
  ): Promise<void> {
    const controlPath = await writeRunControlFile(ctx.cwd, "pause").catch(
      () => runControlFilePath(ctx.cwd),
    );
    queuePipelineWaitControl("pause");
    ctx.ui.notify(
      `Matt Auto: Pause shortcut received. Control file: ${controlPath}`,
      "warning",
    );
    logger?.info("shortcut:pause", { cwd: ctx.cwd, controlPath });

    if (!coordinator) {
      ctx.ui.notify(
        "No active Matt Auto coordinator — if a run is waiting, it should pick up the control file within ~0.5s.",
        "warning",
      );
      return;
    }
    if (coordinator.isRunTerminated()) {
      ctx.ui.notify("Run already terminated.", "info");
      return;
    }
    if (coordinator.isPipelinePaused()) {
      ctx.ui.notify("Pipeline already paused.", "info");
      return;
    }

    const confirm =
      typeof ctx.ui.confirm === "function"
        ? await ctx.ui.confirm(
            "Pause Matt Auto pipeline?",
            "Abort session-owned workers and stop auto-advance. Tracker state is unchanged. Resume or Terminate from the control menu afterward.",
          )
        : true;
    if (!confirm) {
      ctx.ui.notify("Pause cancelled.", "info");
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(runControlFilePath(ctx.cwd));
      } catch {
        // ignore
      }
      return;
    }
    const result = await coordinator.pausePipeline();
    ctx.ui.notify(
      `Pipeline paused. Aborted ${result.abortedWorkerCount} worker(s). Use Ctrl+Shift+X to terminate or Resume from the paused menu.`,
      "warning",
    );
  }

  async function requestTerminateFromShortcut(
    ctx: { cwd: string; ui: { notify: MattAutoUi["notify"]; confirm?: (title: string, message: string) => Promise<boolean> } },
  ): Promise<void> {
    const controlPath = await writeRunControlFile(ctx.cwd, "terminate").catch(
      () => runControlFilePath(ctx.cwd),
    );
    queuePipelineWaitControl("terminate");
    ctx.ui.notify(
      `Matt Auto: Terminate shortcut received. Control file: ${controlPath}`,
      "warning",
    );
    logger?.info("shortcut:terminate", { cwd: ctx.cwd, controlPath });

    if (!coordinator) {
      ctx.ui.notify(
        [
          "No active Matt Auto coordinator in this session.",
          `If a run is waiting, it should stop after reading: ${controlPath}`,
          `Emergency: echo terminate-now > ${controlPath}`,
        ].join("\n"),
        "warning",
      );
      return;
    }
    if (coordinator.isRunTerminated()) {
      ctx.ui.notify("Run already terminated.", "info");
      return;
    }

    const confirm =
      typeof ctx.ui.confirm === "function"
        ? await ctx.ui.confirm(
            "Terminate Matt Auto run?",
            "Abort workers and end this /matt-auto run. Integrated history is preserved when any ticket already integrated or a Workflow PR exists.",
          )
        : true;
    if (!confirm) {
      ctx.ui.notify("Terminate cancelled.", "info");
      // Drop the control file so the wait loop does not re-prompt.
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(runControlFilePath(ctx.cwd));
      } catch {
        // ignore
      }
      return;
    }
    const result = await coordinator.terminateRun();
    // Wait loop observes isRunTerminated / terminate-now without a second dialog.
    await writeRunControlFile(ctx.cwd, "terminate-now").catch(() => undefined);
    ctx.ui.notify(
      `Run terminated (${result.mode}). Aborted ${result.abortedWorkerCount} worker(s).`,
      "warning",
    );
  }

  async function requestMenuFromShortcut(
    ctx: { cwd: string; ui: { notify: MattAutoUi["notify"] } },
  ): Promise<void> {
    const controlPath = await writeRunControlFile(ctx.cwd, "menu").catch(
      () => runControlFilePath(ctx.cwd),
    );
    queuePipelineWaitControl("menu");
    ctx.ui.notify(
      `Matt Auto: control menu queued (Pause/Terminate). File: ${controlPath}`,
      "info",
    );
    logger?.info("shortcut:menu", { cwd: ctx.cwd, controlPath });
  }

  // Primary (Ctrl+Shift — more reliable than Ctrl+Alt in many terminals).
  pi.registerShortcut("ctrl+shift+z", {
    description: "Matt Auto: Pause pipeline (confirm)",
    handler: async (ctx) => {
      await requestPauseFromShortcut(ctx);
    },
  });
  pi.registerShortcut("ctrl+shift+x", {
    description: "Matt Auto: Terminate run (confirm)",
    handler: async (ctx) => {
      await requestTerminateFromShortcut(ctx);
    },
  });
  pi.registerShortcut("ctrl+shift+o", {
    description: "Matt Auto: queue Pause/Terminate control menu",
    handler: async (ctx) => {
      await requestMenuFromShortcut(ctx);
    },
  });
  // Legacy aliases (often swallowed by the terminal).
  pi.registerShortcut("ctrl+alt+p", {
    description: "Matt Auto: Pause pipeline (alias; prefer Ctrl+Shift+Z)",
    handler: async (ctx) => {
      await requestPauseFromShortcut(ctx);
    },
  });
  pi.registerShortcut("ctrl+alt+t", {
    description: "Matt Auto: Terminate run (alias; prefer Ctrl+Shift+X)",
    handler: async (ctx) => {
      await requestTerminateFromShortcut(ctx);
    },
  });
  pi.registerShortcut("ctrl+alt+m", {
    description: "Matt Auto: control menu (alias; prefer Ctrl+Shift+O)",
    handler: async (ctx) => {
      await requestMenuFromShortcut(ctx);
    },
  });

  pi.registerCommand("matt-auto", {
    description:
      "Matt Auto: post-grill pipeline from to-spec through delivery (stage-gated menus)",
    getArgumentCompletions: (prefix) => {
      const args = ["next", "run", "stop", "pause", "resume"];
      const filtered = args.filter((a) => a.startsWith(prefix.trim()));
      return filtered.map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const subcommand = args.trim();
      const ui = uiFrom(ctx);
      const commandStarted = Date.now();
      const homeModel = ctx.model
        ? {
            provider: ctx.model.provider,
            id: ctx.model.id,
            thinkingLevel: String(ctx.thinkingLevel ?? "off"),
            name: ctx.model.name,
            reasoning: Boolean(ctx.model.reasoning),
            ...(ctx.model.thinkingLevelMap
              ? {
                  thinkingLevelMap: ctx.model
                    .thinkingLevelMap as Record<string, string | null>,
                }
              : {}),
          }
        : undefined;

      // Planning skills run in this Workflow home session so grill context remains.
      // A validated plain spec can be reused only before the first invocation;
      // new skill turns wait until assistant text actually appears (not a bare
      // waitForIdle while still idle).
      planningSession = {
        sendUserMessage: (text: string) => {
          pi.sendUserMessage(text);
        },
        waitForIdle: () => ctx.waitForIdle(),
        markAssistantBaseline: () => assistantTexts.length,
        getAssistantTextsSince: (baseline: number) =>
          assistantTexts.slice(Math.max(0, baseline)),
      };

      const active = await ensureCoordinator(
        ctx.cwd,
        ctx.modelRegistry,
        ui,
        homeModel,
      );

      logger.info("command:start", {
        subcommand: subcommand || "menu",
        cwd: ctx.cwd,
        logFile: logger.filePath(),
      });

      try {
        if (subcommand === "" || subcommand === "menu") {
          await presentMainMenu(active, ui, {
            onPipelineStarted: markPipelineStarted,
            onPausedDismissed: markPausedRunDismissed,
          });
          return;
        }

        if (subcommand === "next") {
          await presentNextActions(active, ui);
          return;
        }

        if (subcommand === "run") {
          pausedRunDismissed = false;
          ui.notify(`Matt Auto log: ${logger.filePath()}`, "info");
          await runPostGrillPipeline(active, ui, {
            onPipelineStarted: markPipelineStarted,
            onPausedDismissed: markPausedRunDismissed,
          });
          return;
        }

        // Out-of-band controls when /matt-auto run is blocking (prefer shortcuts
        // or the run-control file). These also work between runs.
        if (subcommand === "stop" || subcommand === "terminate") {
          const controlPath = runControlFilePath(ctx.cwd);
          if (active.isRunTerminated()) {
            ui.notify("Run is already terminated.", "info");
            return;
          }
          // Esc returned a paused run to chat, so no foreground wait loop
          // remains to consume a control file. Keep termination explicitly
          // confirmed here rather than silently leaving an unreachable pause.
          if (pausedRunDismissed && active.isPipelinePaused()) {
            const confirmed = await ui.select(
              "Terminate paused Matt Auto run?",
              ["Confirm Terminate", "Cancel"],
            );
            if (confirmed !== "Confirm Terminate") {
              ui.notify("Terminate cancelled — pipeline remains paused.", "info");
              return;
            }
            const result = await active.terminateRun();
            pausedRunDismissed = false;
            ui.notify(
              `Run terminated (${result.mode}). Aborted ${result.abortedWorkerCount} worker(s).`,
              "warning",
            );
            return;
          }
          // Always write the control file so an in-flight wait loop can see it
          // even when this command races with a blocking /matt-auto run.
          try {
            const { writeFile, mkdir } = await import("node:fs/promises");
            const pathMod = await import("node:path");
            await mkdir(pathMod.dirname(controlPath), { recursive: true });
            await writeFile(controlPath, "terminate\n", "utf8");
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            ui.notify(`Failed to write run-control file: ${message}`, "error");
          }
          queuePipelineWaitControl("terminate");
          if (typeof active.terminateRun === "function" && !active.isPipelinePaused()) {
            // If no wait loop is active, terminate immediately (with confirm via notify).
            // When a wait loop is active it will consume the queue/file instead.
            ui.notify(
              [
                "Terminate requested.",
                "If /matt-auto run is auto-waiting: confirm the Terminate dialog, or it will pick up the control file.",
                `Control file: ${controlPath}`,
                "Emergency (no confirm, another shell): echo terminate-now > .pi/matt-auto/run-control",
              ].join("\n"),
              "warning",
            );
          }
          return;
        }

        if (subcommand === "pause") {
          const controlPath = runControlFilePath(ctx.cwd);
          try {
            const { writeFile, mkdir } = await import("node:fs/promises");
            const pathMod = await import("node:path");
            await mkdir(pathMod.dirname(controlPath), { recursive: true });
            await writeFile(controlPath, "pause\n", "utf8");
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            ui.notify(`Failed to write run-control file: ${message}`, "error");
          }
          queuePipelineWaitControl("pause");
          ui.notify(
            [
              "Pause requested for the active Matt Auto run.",
              "If auto-waiting: confirm the Pause dialog when it appears.",
              `Control file: ${controlPath}`,
            ].join("\n"),
            "warning",
          );
          return;
        }

        if (subcommand === "resume") {
          if (!active.isPipelinePaused()) {
            ui.notify("Pipeline is not paused.", "info");
            return;
          }
          const restartDismissedRun = pausedRunDismissed;
          await active.resumePipeline();
          pausedRunDismissed = false;
          if (!restartDismissedRun) {
            ui.notify("Pipeline resumed.", "info");
            return;
          }
          ui.notify(
            "Pipeline resumed. Restarting orchestration (attempt reuse preferred).",
            "info",
          );
          await runPostGrillPipeline(active, ui, {
            onPipelineStarted: markPipelineStarted,
            onPausedDismissed: markPausedRunDismissed,
          });
          return;
        }

        ctx.ui.notify(
          `Unknown Matt Auto argument "${subcommand}". Try /matt-auto, /matt-auto next, /matt-auto run, /matt-auto stop, /matt-auto pause, or /matt-auto resume.`,
          "error",
        );
      } finally {
        logger.info("command:end", {
          subcommand: subcommand || "menu",
          ms: Date.now() - commandStarted,
        });
      }
    },
  });
}
