# Workflow roots follow Git boundaries

Matt Auto treats each independently managed Git repository as a Workflow root. Packages in a monorepo share their enclosing root, while nested independent repositories are separate roots selectable from Pi; Git submodules are outside the MVP. This preserves correct GitHub, branch, worktree, and state boundaries without implicitly folding child repositories into their parent workflow.
