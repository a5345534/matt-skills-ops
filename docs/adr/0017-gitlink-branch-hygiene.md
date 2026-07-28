# Temporary gitlink branches are GC'd after mainline absorbs them

Dual-root delivery pushes exact submodule SHAs to `matt-auto/gitlink/<shortsha>` so parent gitlinks are never ghosts. Those refs are temporary reachability aids, not product branches.

After Workflow cleanup (PR already merged into the parent Target branch), Matt Auto soft-runs hygiene: prune local worktrees, delete local `matt-auto/<id>/integration-merge` branches, and delete remote gitlink refs **only when** `merge-base --is-ancestor <sha> <submodule-default-branch>`. Tips not yet on mainline are kept and reported so unmerged worker commits are not force-deleted.

Cleanup never fails because GC failed; operators still get a count of deleted vs kept refs on the Stage result and close comment.
