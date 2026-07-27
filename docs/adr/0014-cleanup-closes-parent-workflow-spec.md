# Cleanup closes the parent Workflow spec

Workflow cleanup is not complete when only worktrees, transcripts, and remote matt-auto branches are gone. Operators treat delivery as finished only when the parent Workflow spec issue (Workflow ID) is also closed. Cleanup therefore closes that issue with reason `completed` and a short completion comment (including Workflow PR when known, and the outcome of a safe local pull).

If close fails after local/remote artifact cleanup, cleanup still reports success with a warning (`parentSpecClosed: false`) so irreversible branch/worktree removal is not rolled back; close is idempotent when the issue is already CLOSED.

## Safe local pull after cleanup

After artifacts are cleaned, Matt Auto **attempts** a safe fast-forward of the Workflow root onto `origin/<targetBranch>`:

- HEAD must already be on the Target branch (no checkout switch)
- Working tree must be clean (`git status --porcelain` empty)
- Pull is **FF-only** (`git fetch` + `git merge --ff-only origin/<branch>`)
- On success, `git submodule update --init --recursive` aligns submodule checkouts to recorded gitlinks

Unsafe cases **soft-skip** (do not fail cleanup): dirty tree, wrong branch, detached HEAD, diverged history, fetch/merge errors. The Stage result includes `localPull` so the UI can say whether pull ran or why it was skipped. Pi `/reload` remains operator-owned (session state).
