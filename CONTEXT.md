# Workflow Automation

The language for a Pi Coding Agent extension that coordinates engineering-workflow stages.

## Language

**Stage-gated workflow**:
A workflow where the user explicitly begins each named stage with a slash command, while the extension performs the session and issue-tracker operations required by that stage.
_Avoid_: autopilot run, fully autonomous workflow

**Matt Auto**:
The Pi Coding Agent extension that manages the project’s stage-gated workflow.
_Avoid_: workflow extension, orchestrator

**Next action**:
A stage that is currently available from the persisted workflow state; `matt-auto next` presents the available actions as an interactive selection.
_Avoid_: next step, command list

**Workflow state**:
The durable facts used to determine available Next actions. GitHub issues, labels, blocking edges, and completion status are authoritative; local data is a rebuildable cache for UI preferences and session lineage.
_Avoid_: local workflow state, session state

**Stage confirmation**:
The one interactive approval presented after a stage produces a reviewable artifact. It authorizes the stage’s publication or launch and offers revise or cancel instead of per-operation confirmations.
_Avoid_: silent publishing, per-operation confirmation

**MVP path**:
Matt Auto begins with a clarified solution and progresses through Create spec, Create tickets, and Implement next ready ticket. Grilling and other discovery skills remain outside the first release.
_Avoid_: end-to-end autonomous workflow

**Frontier selection**:
When multiple ready tickets have no unfinished blockers, Matt Auto presents them in an interactive, recommendation-ordered selection rather than choosing one automatically.
_Avoid_: automatic ticket selection

**Frontier launch**:
The multi-select menu action that starts one or more ready tickets as Implementation workers, queueing any excess beyond the current Worker concurrency.
_Avoid_: single-ticket-only launch

**Implementation disposition**:
The user’s post-implementation choice to close a ticket, leave it open, or investigate it further. Choosing Close initiates integration; the ticket closes only after integration succeeds.
_Avoid_: automatic closure

**Implementation workspace**:
An isolated Git branch and worktree assigned to one active implementation ticket.
_Avoid_: shared checkout, shared implementation branch

**Integration stage**:
The stage that combines completed Implementation workspaces into the Integration branch, runs required verification, and resolves any conflicts.
_Avoid_: shared concurrent commits

**Integration unit**:
One completed ticket branch merged, verified, and CI-gated at a time. Parallel implementation does not imply batch integration.
_Avoid_: batch integration

**Integration branch**:
The per-workflow branch containing successfully integrated ticket work. New dependent Implementation workspaces branch from it rather than from an unintegrated ticket workspace.
_Avoid_: target branch, shared checkout

**Integration workspace**:
The dedicated Git worktree where the Workflow coordinator merges and verifies one Integration unit at a time. It is not a visible Pi session and keeps merge work out of Workflow home.
_Avoid_: home-checkout merge, ticket-workspace merge

**Conflict resolution worker**:
A session-owned worker that runs the installed `resolving-merge-conflicts` skill inside the Integration workspace when an Integration unit conflicts. Matt Auto keeps the in-progress merge and does not invent a separate conflict resolver.
_Avoid_: automatic conflict guessing, aborted merge without recovery

**Workspace layout**:
Sibling directories outside the Workflow root that hold Integration and Implementation workspaces for a workflow. Branches use `matt-auto/<Workflow ID>/integration` and `matt-auto/<Workflow ID>/ticket-<n>/r<attempt>` (Integration must not use the bare `matt-auto/<id>` prefix — Git cannot nest refs under an existing branch name).
_Avoid_: in-repo temporary worktrees

**Workflow cleanup**:
The post-merge disposal of a completed workflow’s local workspaces, transcripts, and matching remote matt-auto branches. Local and remote cleanup stay paired so leftovers do not drift. After a Workflow PR merges, the default menu action cleans local and remote artifacts together.
_Avoid_: local-only cleanup, orphan remote branches

**CI gate**:
The GitHub Actions verification required before an integrated ticket can close and unblock dependents. Pending CI returns control to Workflow home; Matt Auto checks it only when a user requests the next action.
_Avoid_: blocking wait, background polling

**Local verification**:
The project-discoverable checks run in the Integration workspace after an Integration unit merges and before push or CI. Failure fails closed into recovery rather than advancing remote state.
_Avoid_: CI-only verification

**Target branch**:
The configured branch that receives a completed workflow. Matt Auto defaults it to `main` when no project-specific target is configured.
_Avoid_: inferred default branch

**Workflow PR**:
The single GitHub pull request from an Integration branch to the Target branch after all workflow tickets have integrated and passed CI. Matt Auto offers its merge as a Next action.
_Avoid_: direct push, per-ticket final PR

**Active workflow**:
An unmerged workflow associated with one Target branch. The MVP allows at most one Active workflow for each Target branch, while its independent tickets may run in parallel.
_Avoid_: concurrent target-branch workflows

**Workflow root**:
An independently managed Git repository scope. Packages in a monorepo share one Workflow root; a nested independent Git repository is a separate Workflow root. Git submodules are outside the MVP.
_Avoid_: parent directory, submodule workflow root

**Root selection**:
The resolution of a Workflow root from the nearest enclosing Git repository, with an interactive option to switch to a discovered nested independent root.
_Avoid_: implicit child-repository inclusion

**Supported tracker**:
A GitHub repository accessible through the `gh` CLI. Workflow roots without a supported GitHub remote are unavailable to the MVP rather than partially automated.
_Avoid_: tracker abstraction, partial non-GitHub support

**Workflow ID**:
The GitHub issue number of a workflow’s published spec. It identifies the workflow’s tickets, branches, worktrees, and Workflow PR.
_Avoid_: local workflow ID, generated opaque ID

**Rework attempt**:
A fresh numbered branch and worktree for a reopened ticket before its Workflow PR merges. It preserves the ticket’s identity without reusing a completed implementation workspace.
_Avoid_: reused worktree, overwritten implementation branch

**Implementation worker**:
A background, isolated Pi process that runs `/implement` for one ticket in its Implementation workspace and emits Stage results to Workflow home.
_Avoid_: visible child session, shared agent process

**Session-owned worker**:
An Implementation worker whose lifetime is bound to the Workflow home Pi process. Shutdown, reload, or Workflow-root switching aborts it cleanly; its GitHub state remains recoverable for a later retry.
_Avoid_: durable worker, orphan process

**Worker concurrency**:
The user-selected number of simultaneous Implementation workers. It defaults to two and has no Matt Auto hard upper limit.
_Avoid_: fixed global worker cap

**Concurrency warning**:
A non-blocking confirmation shown when a requested Worker concurrency exceeds a configurable warning threshold, initially four. Confirming launches the requested number without hidden throttling.
_Avoid_: enforced concurrency maximum

**Worker profile**:
The model and thinking-level configuration used by Implementation workers. Matt Auto selects its model from Pi’s authenticated available-model catalog and its supported thinking level through Pi-style menus without changing the Workflow home model.
_Avoid_: Workflow home model setting, per-launch model prompt

**Worker profile precedence**:
A Worker profile resolves from a global default, then a Workflow-root override, then the snapshot captured by a workflow. Later changes do not alter an existing workflow unless explicitly overridden.
_Avoid_: mutable in-flight worker configuration

**Workflow coordinator**:
The Workflow home component that owns all remote Git and GitHub writes, including pushing ticket branches, manifests, issue mutations, integration, CI queries, and Workflow PR operations. Implementation workers only modify, test, and commit in local worktrees before reporting a Stage result.
_Avoid_: worker-owned remote state, distributed GitHub writes

**Worker protocol**:
The structured Stage-result transport from an Implementation worker to its Workflow coordinator through the worker’s Pi JSON event stream. It carries no GitHub mutation authority.
_Avoid_: worker GitHub writes, shared mutable state file

**Worker transcript**:
The local, uncommitted structured JSON event record for a Worker attempt. Matt Auto retains it through the workflow so the panel can show diagnostics, then offers cleanup after merge.
_Avoid_: GitHub-published transcript, live-only worker output

**Workflow preflight**:
The Matt Auto setup check for a GitHub Workflow root, Target branch, `gh` authentication, required Matt skills, and Worker profile. The MVP guides correction but does not initialize Git or create repositories, commits, or pushes.
_Avoid_: automatic repository bootstrap

**Matt Auto package**:
The reusable Pi package that supplies Matt Auto across Workflow roots. It is installed globally by default, with project-local installation available for shared team setup.
_Avoid_: copied per-repository extension

**Matt skills adapter**:
Matt Auto’s runtime-only orchestration boundary around installed Matt skills. It discovers and invokes their capabilities without modifying, bundling, or pinning their `SKILL.md` definitions.
_Avoid_: forked Matt skills, overridden skills

**Compatibility recovery**:
The fail-closed recovery state entered when an invoked skill omits an expected Stage result or observable artifact. Matt Auto stops rather than guessing state transitions.
_Avoid_: inferred automatic progression

**Workflow manifest**:
The Matt Auto-managed structured GitHub comment on a workflow’s spec issue. It records orchestration metadata such as branches, Worker profile snapshot, attempts, PR and CI references, and current stage without altering the spec body.
_Avoid_: spec-body metadata, state-label proliferation

**Workflow panel**:
A persistent, passive Pi TUI surface showing the Active workflow’s live progress and diagnostics (stage, ticket/attempt, worker identity, process liveness, transcript/worktree paths, integration/PR/errors). It is read-only except for explicit pipeline controls (Pause / Resume / Terminate). It is not a general multi-action dashboard. While `/matt-auto run` is blocked on background work, the primary operator surface is a full-screen read-only brief with the same facts and controls; the compact panel remains a secondary, always-on summary when the TUI supports it.
_Avoid_: forgotten background work, interactive persistent dashboard, one-line-only progress

**Pipeline pause**:
An operator control that, after confirmation, immediately aborts session-owned workers and stops auto-advance of the current Matt Auto run while leaving GitHub workflow state intact. Resume, after confirmation, continues orchestration in the same Workflow home, preferring to reuse the latest unintegrated Implementation attempt (branch/worktree/commits) rather than the aborted worker conversation.
_Avoid_: SIGSTOP freeze of the worker LLM, token-level dialogue resume, silent pause without confirmation

**Run termination**:
An operator control that, after confirmation, ends the current Matt Auto run and aborts session-owned workers. Before any successful Integration unit, it may discard unintegrated attempt workspaces/branches (rollback-to-pre-implement for unfinished work only). After at least one ticket has successfully integrated (or a Workflow PR exists), termination degrades to stop-only: no rewrite of integrated history, closed tickets, or remote Integration state.
_Avoid_: rewrite of integrated history, reopen-all-tickets rollback, silent terminate without confirmation

**Follow-up workflow**:
A new workflow, identified by a new spec issue, created for rework requested after the original Workflow PR has merged. It references rather than mutates the completed workflow.
_Avoid_: reopened merged workflow

**Stage result**:
A one-time structured report emitted when a stage completes, fails, or reaches a confirmation boundary. Matt Auto reacts to it and does not continuously poll for decisions.
_Avoid_: polling, inferred completion

**Workflow home**:
The long-lived session that retains the clarified solution through Create spec and Create tickets, and presents all workflow controls and progress. Each implementation runs in a fresh isolated Implementation worker whose result returns here.
_Avoid_: implementation session, disposable planning session

**Planning stage**:
A Create-spec or Create-tickets stage executed inside Workflow home so the clarified solution remains in context. Only Implementation and Conflict resolution stages use isolated workers.
_Avoid_: planning worker
