# Prefer Matt Auto for multi-ticket delivery in Workflow home

After grilling and domain docs, models often implement product code in the home session even when the operator only wanted ADRs or a pipeline run. Matt skill files already say not to act before shared understanding and place `/implement` later in the main flow, but they do not bind the home agent to Matt Auto.

Without changing Matt skills, the Matt Auto package:

1. Injects a **delivery routing** policy into the Workflow home system prompt on each `before_agent_start` turn — after grill/ADR, **explicitly ask** about `/matt-auto run` rather than silent hand-implementation.
2. Ships a model-discoverable skill **`matt-auto-delivery`** so the agent’s skill list names the post-grill path.
3. Sets a session footer status reminding operators of Matt Auto.

Session-owned Implementation and Conflict workers set `MATT_AUTO_ROLE` so they never receive the home policy (their job is to implement).

We rejected hard-blocking write/edit tools (too brittle for legitimate small fixes) and rejected editing grill-me / implement skill bodies (upstream ownership). Soft prompt + skill discovery + worker env exclusion biases orchestration without stopping operators who deliberately code in home.
