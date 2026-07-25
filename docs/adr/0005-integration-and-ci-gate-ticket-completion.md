# Integration and CI gate ticket completion

A ticket becomes complete only after its Implementation workspace is merged into the workflow Integration branch and GitHub Actions succeeds. Matt Auto returns to Workflow home while CI is pending and checks CI only when the user requests the next action, rather than blocking a session or polling in the background. This keeps GitHub completion state aligned with available code while preserving interactive control.
