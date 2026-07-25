# Workers are owned by the Workflow home session

Matt Auto’s Implementation workers run only while their Workflow home Pi process is alive. Shutdown, reload, or Workflow-root switching aborts workers cleanly; GitHub remains authoritative so a later Next action can recover or retry the affected ticket. We choose this over durable detached workers to avoid a first-release daemon, orphan processes, and complex process recovery.
