# Matt Auto

Stage-gated workflow orchestration for [Pi Coding Agent](https://pi.dev).

Matt Auto is a reusable Pi package. From Workflow home, run:

- `/matt-auto` — interactive menu (Workflow preflight + Next actions)
- `/matt-auto next` — only currently available Next actions

V1 is stage-gated and menu-driven. Product behavior is owned by the **Workflow coordinator** seam; Pi, git/gh, skills, and workspace adapters sit outside that seam.

## Install

```bash
# From a local checkout
pi install /absolute/path/to/matt-skills-ops

# Project-local
pi install -l /absolute/path/to/matt-skills-ops
```

## Develop

```bash
npm install
npm test
npm run typecheck
```

Load the extension without installing:

```bash
pi -e ./extensions/matt-auto.ts
```

## Workflow root selection

Matt Auto resolves the **Workflow root** from the nearest enclosing Git repository:

- Monorepo packages share that single enclosing root
- Nested independent Git repositories are discoverable and selectable from the Matt Auto menu
- Git submodules are out of MVP and are not offered as roots
- Roots without a GitHub remote are marked unavailable with an explicit unsupported-tracker explanation

## Workflow preflight

Preflight checks (fail closed, no bootstrap inventing):

1. GitHub remote on the Workflow root
2. `gh` authentication
3. Target branch (default `main`, overridable per root)
4. Required Matt skills: `to-spec`, `to-tickets`, `implement`, `resolving-merge-conflicts`
5. Worker profile presence (model + thinking level)

Preferences live under:

- Global: `~/.pi/agent/matt-auto/preferences.json`
- Workflow root: `.pi/matt-auto/preferences.json`

### Worker profile

Configure from the Matt Auto menu (**Configure Worker profile…**):

- Global default (all Workflow roots)
- Workflow-root override (current root only)

Model choices come from Pi’s authenticated available-model catalog via a searchable selector. Thinking levels are limited to those the selected model supports. Configuring a Worker profile never changes the Workflow home currently selected model.

Precedence: workflow snapshot (later tickets) → Workflow-root override → global default.

Example preferences:

```json
{
  "workerProfile": {
    "provider": "anthropic",
    "modelId": "claude-sonnet-4",
    "thinkingLevel": "medium"
  }
}
```

## Status

Tickets #2–#4 establish the package shell, coordinator seam, preflight menus, Workflow root selection, and Worker profile defaults. Planning stages, workers, integration, CI, and Workflow PR land in later tickets.
