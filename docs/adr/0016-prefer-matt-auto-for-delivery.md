# Prefer Matt Auto for multi-ticket delivery in Workflow home

After grilling and domain docs, models often implement product code in the home session even when the operator only wanted ADRs or a pipeline run. Matt skill files already say not to act before shared understanding and place `/implement` later in the main flow, but they do not bind the home agent to Matt Auto.

Without changing Matt skills, the Matt Auto package injects a short **delivery routing** policy into the Workflow home system prompt on each `before_agent_start` turn: documentation-only after grill unless the user asks to code; multi-ticket delivery via `/matt-auto run` / `next`; direct edits only for small explicit requests or bugfixes. Session-owned Implementation and Conflict workers set `MATT_AUTO_ROLE` so they never receive this appendix (their job is to implement).

We rejected hard-blocking write/edit tools (too brittle for legitimate small fixes) and rejected editing grill-me / implement skill bodies (upstream ownership). Soft prompt bias plus worker env exclusion keeps orchestration preference without stopping operators who deliberately code in home.
