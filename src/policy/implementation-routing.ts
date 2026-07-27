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
 * Keep short: appended every agent turn — but explicit enough that models
 * actually offer /matt-auto instead of silent hand-implementation.
 */
export const IMPLEMENTATION_ROUTING_POLICY = `
## Matt Auto (installed package — use it)

Matt Auto is the stage-gated delivery path in this session: \`/matt-auto\`, \`/matt-auto next\`, \`/matt-auto run\`.

### When you MUST surface Matt Auto (ask the user)

After any of these, **stop expanding into product implementation** and **explicitly ask** whether to start the pipeline (unless they already refused or only wanted docs):

1. A grill / grill-with-docs / grilling session reaches shared understanding
2. You land or update ADRs / CONTEXT.md for a feature that still needs building
3. The user says they want a feature shipped, multi-ticket work, or "next steps after design"
4. You would otherwise open a large multi-file implementation in Workflow home

Ask in one clear question, for example:
- "Design is captured. Start delivery with \`/matt-auto run\` (to-spec → tickets → implement workers → PR), or stay docs-only?"

### Defaults

- **Grill / domain-modeling / ADR / CONTEXT** → documentation only until shared understanding; then **offer** \`/matt-auto run\`, do not start coding unprompted.
- **Multi-ticket or multi-session feature builds** → \`/matt-auto run\` or \`/matt-auto next\` (not hand-implementing the whole feature in home).
- **Single small change the user explicitly asked to code now** → direct edit / \`/implement\` is OK.
- **Bugs / one-off fixes** they asked you to fix here → direct work is OK.

Do not assume the user knows Matt Auto exists — name the command when offering the next step.
`.trim();

/** Append policy to a system prompt (idempotent if already present). */
export function appendImplementationRoutingPolicy(
  systemPrompt: string,
): string {
  if (systemPrompt.includes("Matt Auto (installed package")) {
    return systemPrompt;
  }
  // Upgrade older marker if present
  if (systemPrompt.includes("Matt Auto delivery routing")) {
    return systemPrompt.replace(
      /## Matt Auto delivery routing[\s\S]*?(?=\n## |\n# |$)/,
      `${IMPLEMENTATION_ROUTING_POLICY}\n\n`,
    );
  }
  return `${systemPrompt}\n\n${IMPLEMENTATION_ROUTING_POLICY}`;
}
