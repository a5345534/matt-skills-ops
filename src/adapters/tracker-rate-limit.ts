/**
 * Process-local GitHub GraphQL budget awareness for Matt Auto tracker calls.
 * Does not replace GitHub's limits — reduces stampeding when already throttled.
 */

export type TrackerGhMetrics = {
  /** GraphQL requests attempted this process. */
  graphqlCalls: number;
  /** REST-ish gh commands (issue/pr) counted when flagged. */
  restCalls: number;
  /** Last time a rate-limit error was observed (epoch ms). */
  lastRateLimitAt: number | undefined;
  /** Do not issue new GraphQL until this epoch ms. */
  backoffUntil: number | undefined;
};

const state: {
  graphqlCalls: number;
  restCalls: number;
  lastRateLimitAt?: number;
  backoffUntil?: number;
} = {
  graphqlCalls: 0,
  restCalls: 0,
};

const DEFAULT_BACKOFF_MS = 60_000;

export function recordGraphqlAttempt(): void {
  state.graphqlCalls += 1;
}

export function recordRestAttempt(): void {
  state.restCalls += 1;
}

export function isGraphqlRateLimitMessage(text: string): boolean {
  return /rate limit|API rate limit already exceeded|secondary rate limit/i.test(
    text,
  );
}

/**
 * Enter backoff after a rate-limit response.
 * Uses reset hint in message when present; otherwise default window.
 */
export function noteGraphqlRateLimit(detail = ""): void {
  const now = Date.now();
  state.lastRateLimitAt = now;
  // gh sometimes includes "reset" unix timestamps; fall back to 60s.
  const resetMatch = detail.match(/\breset[^\d]*(\d{10})\b/i);
  if (resetMatch?.[1]) {
    const resetSec = Number(resetMatch[1]);
    if (Number.isFinite(resetSec) && resetSec * 1000 > now) {
      state.backoffUntil = resetSec * 1000;
      return;
    }
  }
  state.backoffUntil = now + DEFAULT_BACKOFF_MS;
}

export function isInGraphqlBackoff(now = Date.now()): boolean {
  return (
    typeof state.backoffUntil === "number" && now < state.backoffUntil
  );
}

export function graphqlBackoffRemainingMs(now = Date.now()): number {
  if (!isInGraphqlBackoff(now) || state.backoffUntil === undefined) return 0;
  return Math.max(0, state.backoffUntil - now);
}

export function getTrackerGhMetrics(): TrackerGhMetrics {
  return {
    graphqlCalls: state.graphqlCalls,
    restCalls: state.restCalls,
    lastRateLimitAt: state.lastRateLimitAt,
    backoffUntil: state.backoffUntil,
  };
}

/** Test helper. */
export function resetTrackerGhMetricsForTests(): void {
  state.graphqlCalls = 0;
  state.restCalls = 0;
  delete state.lastRateLimitAt;
  delete state.backoffUntil;
}
