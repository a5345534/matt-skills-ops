/**
 * Matt Auto Pi extension — package shell for `/matt-auto` and `/matt-auto next`.
 *
 * Product rules live in the Workflow coordinator. This file only wires Pi
 * commands/menus to coordinator ports.
 *
 * Worker profile menus read Pi’s authenticated available-model catalog and
 * write Matt Auto preferences only — they never change the Workflow home model.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createEnvironmentPort,
  createGitTopologyPort,
  createModelsPort,
  createPreferencesPort,
  createSkillsPort,
} from "../src/adapters/index.js";
import { createWorkflowCoordinator } from "../src/coordinator.js";
import {
  presentMainMenu,
  presentNextActions,
  type MattAutoUi,
} from "../src/ui/menu.js";

function createCoordinatorFor(
  cwd: string,
  modelRegistry: Parameters<typeof createModelsPort>[0],
) {
  return createWorkflowCoordinator({
    startPath: cwd,
    topology: createGitTopologyPort(),
    models: createModelsPort(modelRegistry),
    forRoot(rootPath) {
      return {
        environment: createEnvironmentPort(rootPath),
        skills: createSkillsPort(rootPath),
        preferences: createPreferencesPort(rootPath),
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
      const coordinator = createCoordinatorFor(ctx.cwd, ctx.modelRegistry);
      const ui = uiFrom(ctx);

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
