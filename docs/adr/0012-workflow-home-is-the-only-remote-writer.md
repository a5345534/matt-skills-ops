# Workflow home is the only remote writer

The Workflow coordinator in Workflow home owns every remote Git and GitHub write: ticket-branch pushes, manifests, issue mutations, integration, CI queries, and Workflow PR operations. Implementation workers only modify, test, and commit inside local isolated worktrees before emitting Stage results. This centralizes authorization and serialization, preventing parallel workers from racing or leaving unaccepted remote workflow state.
