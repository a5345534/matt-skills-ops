# GitHub is the workflow state authority

> Superseded for new workflows by [ADR-0019](0019-forgejo-is-the-workflow-forge-authority.md). It remains the legacy authority only while Workflow #53 finishes on GitHub.

Matt Auto must recover available Next actions across Pi sessions and machines. GitHub issues, labels, blocking edges, and completion status are authoritative; `.pi/matt-auto/` holds only rebuildable UI preferences and session lineage. We choose this over local- or session-only state so a workflow remains recoverable and visible without one specific Pi session.
