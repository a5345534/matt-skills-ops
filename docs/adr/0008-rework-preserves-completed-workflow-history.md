# Rework preserves completed workflow history

Before a Workflow PR merges, Matt Auto reopens the affected ticket and creates a fresh numbered Rework attempt while retaining the ticket’s identity. After the Workflow PR merges, Matt Auto creates a new Follow-up workflow with a new spec issue that references the original. This avoids reusing or mutating historical integration branches and keeps completed workflow history traceable.
