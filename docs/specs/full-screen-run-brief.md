# Full-screen run brief with Pause, Resume, and Terminate

Status: drafted (grill consensus + ADR 0013). Not yet implemented as product code.  
Related: `docs/adr/0013-run-brief-pause-resume-terminate.md`, glossary terms **Workflow panel**, **Pipeline pause**, **Run termination** in `CONTEXT.md`.

## Problem Statement

Operators running `/matt-auto run` on an Active workflow cannot see enough live detail to trust what the pipeline is doing. Progress is reduced to sparse one-line notifications and log tails. While the run command legitimately blocks to avoid concurrent orchestration races, that blocking window feels like a black box: no structured view of stage, ticket/attempt, worker identity, process liveness, worktree/transcript paths, integration/PR state, or last failure.

When something goes wrong or the operator wants to stop, there is no first-class control surface on the wait path—only abort-by-reload, process kill, or waiting out the loop. Pause/resume of orchestration and a bounded terminate (discard unfinished implementation work without rewriting integrated history) were grilled and agreed but are not productized.

## Solution

Keep `/matt-auto run` allowed to block (do not prioritize free chat in Workflow home during a run). While the pipeline is waiting on session-owned workers or other long in-run work, replace one-line progress with a **full-screen read-only run brief** as the primary operator surface. Deepen the existing compact **Workflow panel** as a secondary always-on summary when the TUI supports it.

The brief (and panel, where applicable) shows complete live diagnostics drawn from coordinator panel state and related workflow facts. The **only** controls on that surface are **Pause**, **Resume**, and **Terminate**. Each control requires explicit confirmation before taking effect.

- **Pause**: After confirm, immediately abort session-owned workers and stop auto-advance; GitHub workflow state is unchanged.
- **Resume**: After confirm, continue orchestration in the same Workflow home; prefer reusing the latest unintegrated Implementation attempt (branch/worktree/commits), not the aborted worker dialogue.
- **Terminate**: After confirm, end the run and abort workers. Before any successful Integration unit, may discard unintegrated attempt artifacts (rollback unfinished work only). After at least one successful integrate (or a Workflow PR exists), degrade to stop-only—never rewrite integrated history, closed tickets, or remote Integration state.

## User Stories

1. As an operator, I want a full-screen brief while `/matt-auto run` is waiting, so that I can see what the pipeline is doing without reading raw logs.
2. As an operator, I want the brief to show Active workflow id and title, so that I know which workflow is running.
3. As an operator, I want the brief to show the current pipeline step or stage label, so that I know whether we are implementing, integrating, opening a PR, or cleaning up.
4. As an operator, I want the brief to list running workers with ticket number and attempt, so that I can identify the active Implementation or Conflict resolution work.
5. As an operator, I want each worker row to show workerId, so that I can correlate with transcripts and logs.
6. As an operator, I want each worker row to show OS pid when known, so that I can verify the process with system tools.
7. As an operator, I want each worker row to show processAlive, so that I can spot zombie “running” state when the OS process is gone.
8. As an operator, I want each worker row to show branchName and worktreePath, so that I can inspect the Implementation workspace on disk.
9. As an operator, I want each worker row to show transcriptPath, so that I can `tail` progress without guessing paths.
10. As an operator, I want the brief to show the latest progress message from the worker, so that I know what the agent claims to be doing.
11. As an operator, I want needs-disposition state visible on the brief, so that I know Auto-Close is about to run rather than another implement.
12. As an operator, I want pending Integration retry/conflict status on the brief, so that I know integrate is blocked or retrying.
13. As an operator, I want CI gate summary for integrated tickets when relevant, so that I am not surprised by closed vs open tickets.
14. As an operator, I want Workflow PR number/url/status on the brief when a PR exists, so that delivery state is visible.
15. As an operator, I want the last pipeline error or stop reason on the brief, so that failures are not only in the log file.
16. As an operator, I want the brief to refresh periodically while waiting, so that status stays current without leaving the run.
17. As an operator, I want a compact Workflow panel as a secondary surface when the TUI supports widgets, so that progress remains visible outside the full-screen wait when possible.
18. As an operator, I want Pause available from the full-screen brief, so that I can stop auto-advance without killing the Pi process.
19. As an operator, I want Pause to require confirmation, so that I do not abort workers by accident.
20. As an operator, I want Pause to immediately abort all session-owned Implementation and Conflict resolution workers, so that “pause” means stop work now.
21. As an operator, I want Pause to set a paused flag for the current run/coordinator session, so that auto-next does not continue after abort.
22. As an operator, I want Pause to leave GitHub issues, labels, manifests, and integrated history untouched, so that pause is safe.
23. As an operator, I want Resume available after Pause, so that I can continue the same Active workflow without reinventing state.
24. As an operator, I want Resume to require confirmation, so that restart is intentional.
25. As an operator, I want Resume to continue in the same Workflow home session, so that I am not forced into a new Pi window to proceed.
26. As an operator, I want Resume to prefer the latest unintegrated Implementation attempt’s branch and worktree, so that completed or partial commits are not abandoned for a blind rN+1.
27. As an operator, I want Resume, when the latest attempt has a completed Stage result or recoverable completion, to offer disposition/auto-close path rather than re-implement, so that finished work is not redone.
28. As an operator, I want Resume, when the latest attempt is incomplete but has useful commits on the attempt branch, to relaunch a worker on that same attempt branch with a prompt that acknowledges existing work, so that implementation continues on the artifact, not the dead dialogue.
29. As an operator, I want Resume to never claim token-level continuation of an aborted worker conversation, so that expectations match session-owned `--no-session` workers.
30. As an operator, I want Terminate available from the brief, so that I can end a bad run deliberately.
31. As an operator, I want Terminate to require confirmation that states what will be discarded vs preserved, so that I understand the blast radius.
32. As an operator, I want Terminate before any successful Integration unit to abort workers, end the run, and discard unintegrated attempt workspaces/branches for unfinished tickets, so that “rollback to pre-implement” applies only to unfinished work.
33. As an operator, I want Terminate after at least one successful Integration unit (or when a Workflow PR exists) to degrade to stop-only, so that integrated history is never rewritten.
34. As an operator, I want stop-only Terminate to still abort workers and stop auto-advance, so that the run actually ends.
35. As an operator, I want Terminate confirmation copy to differ between pre-integrate (may discard attempts) and post-integrate (stop only), so that late-stage wording is honest.
36. As an operator, I want local matt-auto logs to record pause/resume/terminate decisions with workflow id and affected tickets/attempts, so that post-mortems are possible.
37. As an operator, I want transcript events for pause/abort/terminate on affected attempts, so that attempt history explains why a worker stopped.
38. As an operator, I want the brief to show pipelinePaused when paused, so that I know Resume is the next control.
39. As an operator, I want process-gone reconciliation to remain visible on the brief, so that dead workers clear instead of infinite wait.
40. As an operator, I want Conflict resolution workers included in abort-on-pause/terminate, so that integrate conflicts do not keep running after stop.
41. As a developer, I want these behaviors covered at coordinator and pipeline seams without requiring a live TUI, so that CI can lock the semantics.
42. As an operator, I want no general multi-action dashboard on the brief, so that the control surface stays minimal and safe.
43. As an operator, I want free chat during run to remain out of scope for this change, so that we do not reintroduce concurrent orchestration risk as a side effect of better visibility.

## Implementation Decisions

### Seams

Primary: **WorkflowCoordinator + pipeline wait loop**, via **`getPanelState()`**, **`abortWorkers()`**, and new pause/resume/terminate + attempt-reuse APIs.

Secondary: **pipeline UI** (`runPostGrillPipeline` / `waitForPipelineWorkers`) — full-screen brief loop polling panel state with confirmed controls.

Tertiary: compact **Workflow panel** widget from the same DTO when TUI allows.

### Semantics (locked)

- **U2** full-screen brief primary; **U1** compact panel secondary.
- Pause / Resume / Terminate **all require confirmation**.
- Pause: abort session-owned workers + stop auto-advance; GitHub untouched.
- Resume: same Workflow home; prefer latest **unintegrated** attempt artifacts; not worker dialogue resume.
- Terminate: **T2** discard unintegrated attempts if no successful integrate and no Workflow PR; else **T1** stop-only.
- Late stage: `integratedTickets.length > 0` OR manifest has `workflowPr`.

### Out of product scope for this spec

- Non-blocking `/matt-auto run` / free chat during pipeline.
- Durable worker freeze / token-level resume.
- General interactive dashboard of arbitrary Next actions.
- Rewriting integrated history or reopening closed tickets on Terminate.

## Testing Decisions

- Coordinator: pause flag blocks auto-advance; terminate T1 vs T2; attempt reuse vs blind rN+1.
- Pipeline helpers: brief mapping from panel DTO; stop after terminate.
- Confirm decline → no mutation.
- Prior art: `tests/coordinator.test.ts`, `tests/menu.test.ts`.

## Further Notes

- Inspection handles (pid, transcriptPath, processAlive) already exist on panel workers; consume them.
- Implementation may ship multi-line brief via best available UI primitive if full `custom()` TUI is awkward; semantics over chrome.
