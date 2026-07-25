/**
 * Matt Auto Pi extension — package shell for `/matt-auto` and `/matt-auto next`.
 *
 * Product rules live in the Workflow coordinator. This file only wires Pi
 * commands/menus to coordinator ports.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createEnvironmentPort,
  createPreferencesPort,
  createSkillsPort,
  resolveGitRoot,
} from "../src/adapters/index.js";
import { createWorkflowCoordinator } from "../src/coordinator.js";
import {
  presentMainMenu,
  presentNextActions,
  type MattAutoUi,
} from "../src/ui/menu.js";

async function createCoordinatorFor(cwd: string) {
  const workflowRoot = await resolveGitRoot(cwd);
  return createWorkflowCoordinator({
    environment: createEnvironmentPort(workflowRoot),
    skills: createSkillsPort(workflowRoot),
    preferences: createPreferencesPort(workflowRoot),
  });
}

function uiFrom(ctx: { ui: MattAutoUi }): MattAutoUi {
  return {
    select: (title, options) => ctx.ui.select(title, options),
    notify: (message, type) => ctx.ui.notify(message, type),
  };
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
      const coordinator = await createCoordinatorFor(ctx.cwd);
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
