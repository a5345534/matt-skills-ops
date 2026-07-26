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
  createWorkersPort,
  createWorkspacePort,
  findLatestDraftText,
  parseMarkedSpecDraftFromTexts,
  parseMarkedTicketsDraftFromTexts,
  type MattAutoLogger,
  type SkillsHost,
} from "../src/adapters/index.js";
import { createWorkflowCoordinator } from "../src/coordinator.js";
import type { WorkflowCoordinator } from "../src/types.js";
import {
  presentMainMenu,
  presentNextActions,
  runPostGrillPipeline,
  setMenuLogger,
  type MattAutoUi,
} from "../src/ui/menu.js";

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
/** Only reuse marked drafts from recent assistant turns (grill → draft → run). */
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
        "Running installed /skill:to-spec in Workflow home (no GitHub publish yet)…",
        "info",
      );
      log?.info("runCreateSpec:start");
      const started = Date.now();

      // Grill → (optional draft in session) → /matt-auto run: reuse a recent
      // marked draft so we do not ignore work already in this home session.
      const prior = planning.getAssistantTextsSince(0);
      const reused = parseMarkedSpecDraftFromTexts(prior, {
        recentWindow: RECENT_DRAFT_WINDOW,
      });
      if (reused) {
        log?.info("runCreateSpec:reused-session-draft", {
          title: reused.title,
          bodyChars: reused.body.length,
          priorTextCount: prior.length,
          ms: Date.now() - started,
        });
        return { ok: true, draft: reused };
      }

      // No marked draft yet (typical right after grill): run to-spec and wait
      // for a real agent turn — not a bare waitForIdle while still idle.
      const baseline = planning.markAssistantBaseline();
      planning.sendUserMessage(buildCreateSpecSkillPrompt());
      const texts = await waitForAssistantTextsSince(
        planning,
        baseline,
        log,
        "runCreateSpec",
      );
      const draft = parseMarkedSpecDraftFromTexts(texts);
      log?.debug("runCreateSpec:assistant", {
        textCount: texts.length,
        baseline,
        hasMarker: Boolean(
          findLatestDraftText(texts, "---MATT-AUTO-SPEC-DRAFT---"),
        ),
        ms: Date.now() - started,
      });
      if (!draft) {
        log?.warn("runCreateSpec:parse-failed", {
          preview: (texts[texts.length - 1] ?? "").slice(0, 300),
        });
        return {
          ok: false,
          reason:
            texts.length === 0
              ? "Create-spec did not receive any assistant reply after invoking to-spec (turn wait timed out or never started). Retry Create-spec or /matt-auto run. Nothing was published to GitHub."
              : "Create-spec finished but Matt Auto could not parse a publishable ---MATT-AUTO-SPEC-DRAFT--- block (markers required; no marker-less fallback). Retry Create-spec or /matt-auto run. Nothing was published to GitHub.",
        };
      }
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
        `Running installed /skill:to-tickets for Workflow #${input.workflowId} (no GitHub publish yet)…`,
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
          "Create-tickets finished but Matt Auto could not parse a valid ---MATT-AUTO-TICKETS-DRAFT--- JSON block after 2 attempts (markers required). Retry Create-tickets. Nothing was published to GitHub.",
      };
    },
  };
}

function uiFrom(ctx: {
  ui: MattAutoUi & {
    input?: (
      title: string,
      placeholder?: string,
    ) => Promise<string | undefined>;
    editor?: (title: string, prefill?: string) => Promise<string | undefined>;
  };
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
  const assistantTexts: string[] = [];

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

  function ensureCoordinator(
    cwd: string,
    modelRegistry: Parameters<typeof createModelsPort>[0],
    ui: MattAutoUi,
    homeModel: typeof homeModelRef,
  ): WorkflowCoordinator {
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
      void coordinator.abortWorkers();
    }

    logger = createMattAutoLogger(cwd);
    setMenuLogger(logger);
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
    }
    coordinator = undefined;
    boundCwd = undefined;
    boundModelRegistry = undefined;
    activeUi = undefined;
    planningSession = undefined;
    assistantTexts.length = 0;
  });

  pi.registerCommand("matt-auto", {
    description:
      "Matt Auto: post-grill pipeline from to-spec through delivery (stage-gated menus)",
    getArgumentCompletions: (prefix) => {
      const args = ["next", "run"];
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
      // Marked drafts may be reused from recent turns; new skill turns wait until
      // assistant text actually appears (not bare waitForIdle while still idle).
      planningSession = {
        sendUserMessage: (text: string) => {
          pi.sendUserMessage(text);
        },
        waitForIdle: () => ctx.waitForIdle(),
        markAssistantBaseline: () => assistantTexts.length,
        getAssistantTextsSince: (baseline: number) =>
          assistantTexts.slice(Math.max(0, baseline)),
      };

      const active = ensureCoordinator(
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
          await presentMainMenu(active, ui);
          return;
        }

        if (subcommand === "next") {
          await presentNextActions(active, ui);
          return;
        }

        if (subcommand === "run") {
          ui.notify(`Matt Auto log: ${logger.filePath()}`, "info");
          await runPostGrillPipeline(active, ui);
          return;
        }

        ctx.ui.notify(
          `Unknown Matt Auto argument "${subcommand}". Try /matt-auto, /matt-auto next, or /matt-auto run.`,
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
