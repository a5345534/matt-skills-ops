# Workflow home is the only remote writer

> The single-writer rule remains current; [ADR-0019](0019-forgejo-is-the-workflow-forge-authority.md) changes its forge from GitHub to Forgejo for new workflows.

The Workflow coordinator in Workflow home owns every remote Git and GitHub write: ticket-branch pushes, manifests, issue mutations, integration, CI queries, and Workflow PR operations. Implementation workers only modify, test, and commit inside local isolated worktrees before emitting Stage results. This centralizes authorization and serialization, preventing parallel workers from racing or leaving unaccepted remote workflow state.
