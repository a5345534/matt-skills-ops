# Workflows land through a single GitHub PR

After all ticket work has integrated and passed CI, Matt Auto opens one Workflow PR from the Integration branch to the configured Target branch, defaulting to `main`. The user merges it through Matt Auto as a Next action rather than directly pushing to the Target branch. This preserves GitHub review, CI, and branch-protection records without requiring manual GitHub operation.
