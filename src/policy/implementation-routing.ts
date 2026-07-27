/**
 * Home-session policy: prefer Matt Auto for multi-ticket / post-grill delivery.
 * Injected via before_agent_start in the Matt Auto extension — does not modify
 * Matt skill files. Worker processes must not receive this text.
 */

/** Env flag set on session-owned Implementation / Conflict workers. */
export const MATT_AUTO_WORKER_ENV = "MATT_AUTO_ROLE" as const;

export type MattAutoWorkerRole =
  | "implementation-worker"
  | "conflict-worker";

/** True when this process is a Matt Auto worker (not Workflow home). */
export function isMattAutoWorkerProcess(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const role = env[MATT_AUTO_WORKER_ENV];
  return role === "implementation-worker" || role === "conflict-worker";
}

/**
 * Compact system-prompt appendix for Workflow home.
 * Keep short: appended every agent turn.
 */
export const IMPLEMENTATION_ROUTING_POLICY = `
## Matt Auto delivery routing (package policy)

When Matt Auto is installed, prefer its stage-gated path for **feature delivery** after discovery:

- **Grill / domain-modeling / ADR / CONTEXT** → documentation only until the user confirms shared understanding. Do **not** implement product code as the default next step after grilling.
- **Multi-ticket or multi-session builds** → \`/matt-auto run\` or \`/matt-auto next\` (Create-spec → Create-tickets → Implement workers → Integration → PR). Do not hand-implement the whole feature in Workflow home.
- **Single small change the user explicitly asked to code now** → direct edit/\`/implement\` is OK.
- **Bugs / one-off fixes** the user asked you to fix in this session → direct work is OK.

If the user only wants decisions landed (ADR, glossary), stop after docs. Offer \`/matt-auto run\` when they are ready to ship through the pipeline, instead of expanding into full implementation unprompted.
`.trim();

/** Append policy to a system prompt (idempotent if already present). */
export function appendImplementationRoutingPolicy(
  systemPrompt: string,
): string {
  if (systemPrompt.includes("Matt Auto delivery routing")) {
    return systemPrompt;
  }
  return `${systemPrompt}\n\n${IMPLEMENTATION_ROUTING_POLICY}`;
}
