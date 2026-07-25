# Independent tickets run in isolated worktrees

Frontier tickets without unfinished blockers may run in parallel. Matt Auto creates a dedicated branch and Git worktree for each active ticket instead of sharing one checkout. An explicit Integration stage combines completed workspaces into the target branch and resolves conflicts, trading setup and merge overhead for safe independent concurrency.
