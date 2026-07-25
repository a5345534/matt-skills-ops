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
  createModelsPort,
  createPreferencesPort,
  createRemoteGitPort,
  createSkillsPort,
  createTrackerPort,
  createTranscriptPort,
  createVerificationPort,
  createWorkersPort,
  createWorkspacePort,
  parseSpecDraftFromAssistantText,
  parseTicketsDraftFromAssistantText,
  type SkillsHost,
} from "../src/adapters/index.js";
import { createWorkflowCoordinator } from "../src/coordinator.js";
import type { WorkflowCoordinator } from "../src/types.js";
import {
  presentMainMenu,
  presentNextActions,
  runPostGrillPipeline,
  type MattAutoUi,
} from "../src/ui/menu.js";

type PlanningSession = {
  sendUserMessage: (text: string) => void;
  waitForIdle: () => Promise<void>;
  getLastAssistantText: () => string;
};

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
): SkillsHost {
  return {
    async runCreateSpec() {
      const ui = getUi();
      const planning = getPlanning();
      if (!ui || !planning) {
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

      planning.sendUserMessage(buildCreateSpecSkillPrompt());
      await planning.waitForIdle();

      const draft = parseSpecDraftFromAssistantText(
        planning.getLastAssistantText(),
      );
      if (!draft) {
        return {
          ok: false,
          reason:
            "Create-spec did not produce a publishable draft after /skill:to-spec. Ensure the grilling conversation has enough substance, then retry Create-spec. Matt Auto does not publish empty or placeholder drafts.",
        };
      }
      return { ok: true, draft };
    },

    async runCreateTickets(input) {
      const ui = getUi();
      const planning = getPlanning();
      if (!ui || !planning) {
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

      planning.sendUserMessage(buildCreateTicketsSkillPrompt(input));
      await planning.waitForIdle();

      const draft = parseTicketsDraftFromAssistantText(
        planning.getLastAssistantText(),
      );
      if (!draft) {
        return {
          ok: false,
          reason:
            "Create-tickets did not produce a valid breakdown after /skill:to-tickets. Retry Create-tickets. Matt Auto does not publish until Stage confirmation Publish.",
        };
      }
      return { ok: true, draft };
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
  let lastAssistantText = "";

  const skillsHost = createSkillsHost(
    () => activeUi,
    () => planningSession,
  );

  pi.on("message_end", async (event) => {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role === "assistant") {
      const text = extractAssistantText(message);
      if (text.trim()) {
        lastAssistantText = text;
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
    lastAssistantText = "";
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
      planningSession = {
        sendUserMessage: (text: string) => {
          lastAssistantText = "";
          pi.sendUserMessage(text);
        },
        waitForIdle: () => ctx.waitForIdle(),
        getLastAssistantText: () => lastAssistantText,
      };

      const active = ensureCoordinator(
        ctx.cwd,
        ctx.modelRegistry,
        ui,
        homeModel,
      );

      if (subcommand === "" || subcommand === "menu") {
        await presentMainMenu(active, ui);
        return;
      }

      if (subcommand === "next") {
        await presentNextActions(active, ui);
        return;
      }

      if (subcommand === "run") {
        // Post-grill entry: drive to-spec → tickets → implement… with stage confirms.
        await runPostGrillPipeline(active, ui);
        return;
      }

      ctx.ui.notify(
        `Unknown Matt Auto argument "${subcommand}". Try \`/matt-auto\`, \`/matt-auto next\`, or \`/matt-auto run\`.`,
        "error",
      );
    },
  });
}
