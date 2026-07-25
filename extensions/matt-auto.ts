/**
 * Matt Auto Pi extension — package shell for `/matt-auto` and `/matt-auto next`.
 *
 * Product rules live in the Workflow coordinator. This file only wires Pi
 * commands/menus to coordinator ports.
 *
 * Planning stages (Create-spec, Create-tickets) run in Workflow home: the Matt
 * skills adapter invokes installed skills via a host without modifying skill
 * definitions, then Stage confirmation (Publish / Revise / Cancel) gates remote
 * publication through the coordinator.
 *
 * Implementation workers are session-owned: the WorkersPort and coordinator
 * live for the Pi session and abort cleanly on session_shutdown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createEnvironmentPort,
  createGitTopologyPort,
  createModelsPort,
  createPreferencesPort,
  createCiPort,
  createRemoteGitPort,
  createSkillsPort,
  createTrackerPort,
  createTranscriptPort,
  createVerificationPort,
  createWorkersPort,
  createWorkspacePort,
  type SkillsHost,
} from "../src/adapters/index.js";
import { createWorkflowCoordinator } from "../src/coordinator.js";
import type { WorkflowCoordinator } from "../src/types.js";
import {
  captureCreateSpecDraft,
  captureCreateTicketsDraft,
  presentMainMenu,
  presentNextActions,
  type MattAutoUi,
} from "../src/ui/menu.js";

function createSkillsHost(getUi: () => MattAutoUi | undefined): SkillsHost {
  return {
    async runCreateSpec() {
      const ui = getUi();
      if (!ui) {
        return {
          ok: false,
          reason:
            "Create-spec Planning host has no active UI. Retry from /matt-auto.",
        };
      }
      // Orchestration wrapper around installed to-spec:
      // capture a reviewable draft only — never publish (coordinator owns that).
      const draft = await captureCreateSpecDraft(ui);
      if (!draft) {
        return {
          ok: false,
          reason:
            "Create-spec draft was not produced. Follow the installed to-spec skill to synthesize a title and body, then retry. Matt Auto does not publish until Stage confirmation Publish.",
        };
      }
      return { ok: true, draft };
    },

    async runCreateTickets(input) {
      const ui = getUi();
      if (!ui) {
        return {
          ok: false,
          reason:
            "Create-tickets Planning host has no active UI. Retry from /matt-auto.",
        };
      }
      // Orchestration wrapper around installed to-tickets:
      // capture a reviewable breakdown only — never publish (coordinator owns that).
      const draft = await captureCreateTicketsDraft(ui, input);
      if (!draft) {
        return {
          ok: false,
          reason:
            "Create-tickets breakdown was not produced. Follow the installed to-tickets skill to synthesize a vertical-slice breakdown with blockedBy edges, then retry. Matt Auto does not publish until Stage confirmation Publish.",
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
  // Session-scoped resources: workers and coordinator survive across commands.
  const workers = createWorkersPort();
  let activeUi: MattAutoUi | undefined;
  let coordinator: WorkflowCoordinator | undefined;
  let boundCwd: string | undefined;
  let boundModelRegistry: Parameters<typeof createModelsPort>[0] | undefined;
  // Updated on every /matt-auto invocation so "use home model" stays current.
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

  const skillsHost = createSkillsHost(() => activeUi);

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

    // Cwd or model registry change: abort prior session-owned workers first.
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
    // Session-owned workers abort cleanly; GitHub state remains recoverable.
    if (coordinator) {
      await coordinator.abortWorkers();
    }
    coordinator = undefined;
    boundCwd = undefined;
    boundModelRegistry = undefined;
    activeUi = undefined;
  });

  pi.registerCommand("matt-auto", {
    description:
      "Matt Auto: stage-gated workflow menus and Next actions",
    getArgumentCompletions: (prefix) => {
      const args = ["next"];
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

      ctx.ui.notify(
        `Unknown Matt Auto argument "${subcommand}". Try \`/matt-auto\` or \`/matt-auto next\`.`,
        "error",
      );
    },
  });
}
