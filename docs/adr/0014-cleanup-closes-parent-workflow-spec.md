# Cleanup closes the parent Workflow spec

Workflow cleanup is not complete when only worktrees, transcripts, and remote matt-auto branches are gone. Operators treat delivery as finished only when the parent Workflow spec issue (Workflow ID) is also closed. Cleanup therefore closes that issue with reason `completed` and a short completion comment (including Workflow PR when known, and a reminder to `git pull` + `/reload`).

If close fails after local/remote artifact cleanup, cleanup still reports success with a warning (`parentSpecClosed: false`) so irreversible branch/worktree removal is not rolled back; close is idempotent when the issue is already CLOSED. Matt Auto does not run `git pull` or reload Pi for the operator—only notifies—because working-tree sync and extension reload are session/machine local and unsafe to force.
