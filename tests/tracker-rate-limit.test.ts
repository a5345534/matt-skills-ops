import { describe, expect, it, beforeEach } from "vitest";
import {
  getTrackerGhMetrics,
  graphqlBackoffRemainingMs,
  isGraphqlRateLimitMessage,
  isInGraphqlBackoff,
  noteGraphqlRateLimit,
  recordGraphqlAttempt,
  resetTrackerGhMetricsForTests,
} from "../src/adapters/tracker-rate-limit.js";

describe("tracker rate-limit helpers", () => {
  beforeEach(() => {
    resetTrackerGhMetricsForTests();
  });

  it("detects GitHub GraphQL rate-limit messages", () => {
    expect(
      isGraphqlRateLimitMessage(
        "GraphQL: API rate limit already exceeded for user ID 65459035.",
      ),
    ).toBe(true);
    expect(isGraphqlRateLimitMessage("network timeout")).toBe(false);
  });

  it("enters backoff after noteGraphqlRateLimit", () => {
    noteGraphqlRateLimit("rate limit exceeded");
    expect(isInGraphqlBackoff()).toBe(true);
    expect(graphqlBackoffRemainingMs()).toBeGreaterThan(0);
    expect(getTrackerGhMetrics().lastRateLimitAt).toBeTypeOf("number");
  });

  it("counts graphql attempts", () => {
    recordGraphqlAttempt();
    recordGraphqlAttempt();
    expect(getTrackerGhMetrics().graphqlCalls).toBe(2);
  });
});
