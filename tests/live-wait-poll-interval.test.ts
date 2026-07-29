import { describe, expect, it } from "vitest";
import {
  assertValidLiveWaitPollIntervalMs,
  isValidLiveWaitPollIntervalMs,
  resolveLiveWaitPollInterval,
} from "../src/adapters/preferences.js";
import {
  DEFAULT_LIVE_WAIT_POLL_INTERVAL_MS,
  MAX_LIVE_WAIT_POLL_INTERVAL_MS,
  MIN_LIVE_WAIT_POLL_INTERVAL_MS,
} from "../src/constants.js";
import {
  formatResolvedLiveWaitPollIntervalLine,
  parseLiveWaitPollIntervalInput,
} from "../src/ui/menu.js";

describe("live wait poll interval preferences", () => {
  it("validates integer bounds", () => {
    expect(isValidLiveWaitPollIntervalMs(MIN_LIVE_WAIT_POLL_INTERVAL_MS)).toBe(
      true,
    );
    expect(isValidLiveWaitPollIntervalMs(MAX_LIVE_WAIT_POLL_INTERVAL_MS)).toBe(
      true,
    );
    expect(isValidLiveWaitPollIntervalMs(199)).toBe(false);
    expect(isValidLiveWaitPollIntervalMs(10_001)).toBe(false);
    expect(isValidLiveWaitPollIntervalMs(500.5)).toBe(false);
    expect(() => assertValidLiveWaitPollIntervalMs(100)).toThrow(/200/);
  });

  it("resolves root → global → default", () => {
    expect(resolveLiveWaitPollInterval(undefined, undefined)).toEqual({
      intervalMs: DEFAULT_LIVE_WAIT_POLL_INTERVAL_MS,
      source: "default",
    });
    expect(resolveLiveWaitPollInterval(undefined, 1000)).toEqual({
      intervalMs: 1000,
      source: "global",
    });
    expect(resolveLiveWaitPollInterval(750, 1000)).toEqual({
      intervalMs: 750,
      source: "workflow-root",
    });
  });

  it("parses user input with optional ms suffix", () => {
    expect(parseLiveWaitPollIntervalInput("800")).toEqual({
      ok: true,
      value: 800,
    });
    expect(parseLiveWaitPollIntervalInput("1200ms")).toEqual({
      ok: true,
      value: 1200,
    });
    expect(parseLiveWaitPollIntervalInput("50").ok).toBe(false);
    expect(formatResolvedLiveWaitPollIntervalLine(500, "default")).toBe(
      "Effective live wait poll: 500ms [default]",
    );
  });
});
