/**
 * Matt Auto Pi extension — package shell for `/matt-auto` and `/matt-auto next`.
 *
 * Product rules live in the Workflow coordinator. This file only wires Pi
 * commands/menus to coordinator ports.
 *
 * Create-spec runs as a Planning stage in Workflow home: the Matt skills
 * adapter invokes installed `to-spec` via a host without modifying skill
 * definitions, then Stage confirmation (Publish / Revise / Cancel) gates
 * remote publication through the coordinator.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createEnvironmentPort,
  createGitTopologyPort,
  createModelsPort,
  createPreferencesPort,
  createSkillsPort,
  createTrackerPort,
  type CreateSpecHost,
} from "../src/adapters/index.js";
import { createWorkflowCoordinator } from "../src/coordinator.js";
import {
  captureCreateSpecDraft,
  presentMainMenu,
  presentNextActions,
  type MattAutoUi,
} from "../src/ui/menu.js";

function createCreateSpecHost(ui: MattAutoUi): CreateSpecHost {
  return {
    async runCreateSpec() {
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
  };
}

function createCoordinatorFor(
  cwd: string,
  modelRegistry: Parameters<typeof createModelsPort>[0],
  ui: MattAutoUi,
) {
  const createSpecHost = createCreateSpecHost(ui);
  return createWorkflowCoordinator({
    startPath: cwd,
    topology: createGitTopologyPort(),
    models: createModelsPort(modelRegistry),
    forRoot(rootPath) {
      return {
        environment: createEnvironmentPort(rootPath),
        skills: createSkillsPort(rootPath, createSpecHost),
        preferences: createPreferencesPort(rootPath),
        tracker: createTrackerPort(rootPath),
      };
    },
  });
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
      const coordinator = createCoordinatorFor(ctx.cwd, ctx.modelRegistry, ui);

      if (subcommand === "" || subcommand === "menu") {
        await presentMainMenu(coordinator, ui);
        return;
      }

      if (subcommand === "next") {
        await presentNextActions(coordinator, ui);
        return;
      }

      ctx.ui.notify(
        `Unknown Matt Auto argument "${subcommand}". Try \`/matt-auto\` or \`/matt-auto next\`.`,
        "error",
      );
    },
  });
}
