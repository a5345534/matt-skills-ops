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

## Create-spec Planning stage

When Workflow preflight passes and there is no Active workflow, Next actions include **Create spec**:

1. Matt Auto invokes the installed `to-spec` skill as a Planning stage in Workflow home (skill definitions are not modified).
2. The draft reaches one **Stage confirmation** menu: Publish / Revise / Cancel.
3. **Publish** creates a GitHub spec issue (Workflow ID) and writes a managed **Workflow manifest** comment on that issue.
4. **Cancel** leaves no remote publication. **Revise** re-invokes `to-spec` without publishing.
5. After publish, Next actions advance to **Create tickets**.

## Create-tickets Planning stage and frontier discovery

When an Active workflow is in stage `spec-published`, Next actions include **Create tickets**:

1. Matt Auto invokes the installed `to-tickets` skill as a Planning stage in Workflow home (skill definitions are not modified).
2. The breakdown reaches one **Stage confirmation** menu: Publish / Revise / Cancel.
3. **Publish** creates GitHub ticket issues (with `ready-for-agent`), links them as sub-issues of the Workflow ID, sets native **blocked-by** relationships, and updates the Workflow manifest (`stage: tickets-published`, `tickets: [...]`).
4. **Cancel** leaves no remote publication. **Revise** re-invokes `to-tickets` without publishing.
5. After publish, the coordinator computes the **ready frontier** from GitHub issue state (open tickets with no open blockers).
6. Next actions and the Matt Auto menu show a **ticket-progress summary** (ready / open / closed + frontier).

Implementation workers that launch frontier tickets land in later tickets.

## Status

Tickets #2–#6 establish the package shell, coordinator seam, preflight menus, Workflow root selection, Worker profile defaults, Create-spec / Create-tickets Planning stages, Workflow manifest, and frontier discovery. Implementation workers, integration, CI, and Workflow PR land in later tickets.
