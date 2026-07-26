# Full-screen run brief with Pause / Resume / Terminate

During `/matt-auto run`, operator visibility mattered more than free chat in Workflow home. We keep the run command allowed to block (avoids concurrent orchestration races) and replace one-line progress with a full-screen read-only brief as the primary surface, plus a secondary compact Workflow panel when the TUI allows it. The only controls on that surface are Pause, Resume, and Terminate — each requires confirmation.

Pause immediately aborts session-owned workers and stops auto-advance without rewriting GitHub workflow state. Resume continues orchestration in the same Workflow home and prefers reusing the latest unintegrated Implementation attempt (branch/worktree/commits), not the aborted worker dialogue. Terminate ends the run and aborts workers; before any successful Integration unit it may discard unintegrated attempt artifacts, and after integrate/PR it degrades to stop-only so integrated history is never rewritten.

We rejected unblocking home chat as the first fix (higher race risk for little gain while workers already run out-of-process), durable worker freeze/resume (conflicts with session-owned `--no-session` workers), and a general interactive dashboard (control surface stays minimal).
