# Implementation worker concurrency on the run path

Matt Auto’s glossary already defined Worker concurrency (default two, warning at four) and parallel independent tickets, but `/matt-auto run` used a single `activeWorker` and refused concurrent launches. We productize concurrency for **Implementation workers only**: N resolves global → Workflow-root (default 2); empty slots are filled from the ready frontier; when slots are full the pipeline waits. **Integration units, Conflict resolution, and Planning stay serial.** When a disposition or Integration unit is pending, new Implementation launches wait (P1); already-running workers continue. Setting N above the warning threshold (initially 4) requires a one-time confirmation; run does not re-prompt per ticket and does not hard-cap N.

We rejected concurrent Integration (merge workspace is exclusive) and “fill all implement slots before any Close” (stacks dispositions and fights single Integration unit semantics).
