# Matt Auto

Stage-gated workflow orchestration for [Pi Coding Agent](https://pi.dev).

Matt Auto is a reusable Pi package. From Workflow home (after grilling), run:

- `/matt-auto` — interactive menu (Workflow preflight + Next actions)
- `/matt-auto next` — only currently available Next actions
- `/matt-auto run` — post-grill **auto-advance** pipeline: `/skill:to-spec` → auto-publish → `/skill:to-tickets` → auto-publish → implement… (auto-Close starts Integration). Manual menu actions still prompt.

V1 is stage-gated and menu-driven. Planning stages invoke the **installed** Matt skills in Workflow home (skill definitions are not modified). Product behavior is owned by the **Workflow coordinator** seam.

## Install

```bash
# From a local checkout
pi install /absolute/path/to/matt-skills-ops

# Project-local
pi install -l /absolute/path/to/matt-skills-ops
```

## Debug log

Matt Auto writes an append-only local log (not committed / not pushed to GitHub):

```text
<workflow-root>/.pi/matt-auto/logs/matt-auto-YYYY-MM-DD.log
```

`/matt-auto run` prints the log path. Useful events: `pipeline:nextActions`, `pipeline:select`, `handleNextAction:*`, `runCreateSpec:*`, `runCreateTickets:*`, timings (`ms`), and stop reasons.

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

When Workflow preflight passes and there is no Active workflow, Next actions include **Create spec** (also the start of `/matt-auto run`):

1. Matt Auto sends `/skill:to-spec` in **this Workflow home session** so the prior grill conversation stays in context.
2. The skill is instructed **not** to publish to GitHub; it must emit a Matt Auto draft marker block.
3. Empty / placeholder drafts are rejected (Compatibility recovery).
4. **Manual menu**: Stage confirmation Publish / Revise / Cancel.
5. **`/matt-auto run`**: auto-Publishes (no human Publish click).
6. Publish creates a GitHub spec issue (Workflow ID) + Workflow manifest comment.
7. After publish, Next actions advance to **Create tickets** (`/matt-auto run` continues automatically).

## Create-tickets Planning stage and frontier discovery

When an Active workflow is in stage `spec-published`, Next actions include **Create tickets**:

1. Matt Auto invokes the installed `to-tickets` skill as a Planning stage in Workflow home (skill definitions are not modified).
2. The breakdown reaches one **Stage confirmation** menu: Publish / Revise / Cancel.
3. **Publish** creates GitHub ticket issues (with `ready-for-agent`), links them as sub-issues of the Workflow ID, sets native **blocked-by** relationships, and updates the Workflow manifest (`stage: tickets-published`, `tickets: [...]`).
4. **Cancel** leaves no remote publication. **Revise** re-invokes `to-tickets` without publishing.
5. After publish, the coordinator computes the **ready frontier** from GitHub issue state (open tickets with no open blockers).
6. Next actions and the Matt Auto menu show a **ticket-progress summary** (ready / open / closed + frontier).

## Single Implementation worker path

When tickets are published and the ready frontier is non-empty, Next actions include **Implement #N** for each ready ticket:

1. Matt Auto creates an **Implementation workspace** outside the Workflow root (sibling `matt-auto-workspaces/…` worktree) on branch `matt-auto/<Workflow ID>/ticket-<n>/r<attempt>`.
2. A **session-owned Implementation worker** runs `/implement` via the Matt skills adapter in that workspace (Worker profile model + thinking level).
3. Progress streams over the **Worker protocol** (Pi JSON event stream → Stage results). The passive **Workflow panel** shows condensed running status from the same panel DTO as the full-screen run brief (workflow id, pause state, worker ticket/status/alive, optional progress). When the Pi TUI exposes `setWidget`/`setStatus`, that summary is also published as a secondary always-on surface; without those APIs the publish is a no-op and the full-screen brief remains primary. The Workflow panel is not an interactive dashboard.
4. A local **Worker transcript** is retained under `.pi/matt-auto/transcripts/` for the attempt.
5. On success, **Implementation disposition** offers Close / Leave open / Investigate.
6. **Close** starts a serialized **Integration unit** (does **not** close the GitHub ticket yet).
7. Workers only commit locally. The Workflow coordinator remains the only remote writer for push, manifest, and issue mutations.
8. Shutdown, reload, or Workflow-root switching **aborts** the worker cleanly; GitHub tickets stay open/ready for retry.

## Integration unit

Choosing **Close** on a completed Implementation disposition runs one Integration unit at a time:

1. Ensure a dedicated **Integration workspace** worktree outside the Workflow root on branch `matt-auto/<Workflow ID>/integration` (not Workflow home; never bare `matt-auto/<id>` — Git ref prefix conflict with ticket branches).
2. Merge the ticket branch into the Integration branch (local only).
3. On **merge conflict**: keep the in-progress merge and launch a session-owned **Conflict resolution worker** in the Integration workspace that runs the installed `resolving-merge-conflicts` skill (Matt Auto does not invent a separate conflict resolver).
4. On successful Conflict resolution (or a clean merge): run **Local verification** — project-discoverable checks (e.g. `package.json` scripts `typecheck` / `test`) in the Integration workspace.
5. On Local verification failure: **fail closed** — no push, no Workflow manifest update; Next actions offer **Retry Integration #N**.
6. On Conflict resolution failure or missing Stage result: enter Compatibility / integration recovery without guessing merges; retry re-launches Conflict resolution without re-merging.
7. On success: the Workflow coordinator pushes the Integration branch (and ticket branch) and updates the Workflow manifest (`integrationBranch`, `integratedTickets`).
8. On-demand **CI gate**: pending returns control immediately; `/matt-auto next` rechecks once; green closes the ticket and unblocks dependents; red offers inspect / retry / leave-open.
9. Later Implementation workspaces branch from the Integration branch so dependents see integrated code.

## Workflow PR, cleanup, rework, and follow-up

When **all tickets** are integrated and CI-complete:

1. **Open Workflow PR** — one PR from the Integration branch to the configured Target branch (default `main`).
2. **Merge Workflow PR** — offered as a Matt Auto Next action (no manual GitHub merge required).
3. **Cleanup workflow** — pairs local workspaces/transcripts with matching remote `matt-auto/*` branch removal; retains GitHub issue/PR/manifest history.
4. **Pre-merge Rework** — reopens a closed ticket and creates a fresh numbered attempt workspace (`…/rN`) without reusing the completed workspace.
5. **Start Follow-up workflow** — after merge + cleanup, creates a new spec issue that references the completed Workflow rather than mutating it.

Frontier multi-select concurrency lands in a later ticket.

## Status

Tickets #2–#7 and #9–#12 establish the package shell, coordinator seam, preflight menus, Workflow root selection, Worker profile defaults, Create-spec / Create-tickets Planning stages, Workflow manifest, frontier discovery, the single Implementation worker path, Integration units, Conflict resolution workers, on-demand CI gate / ticket close, Workflow PR, paired cleanup, pre-merge Rework attempts, and Follow-up workflows. Multi-worker concurrency lands in a later ticket.
