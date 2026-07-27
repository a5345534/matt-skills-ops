import { describe, expect, it } from "vitest";
import {
  appendImplementationRoutingPolicy,
  IMPLEMENTATION_ROUTING_POLICY,
  isMattAutoWorkerProcess,
} from "../src/policy/implementation-routing.js";

describe("isMattAutoWorkerProcess", () => {
  it("detects implementation and conflict worker roles", () => {
    expect(
      isMattAutoWorkerProcess({ MATT_AUTO_ROLE: "implementation-worker" }),
    ).toBe(true);
    expect(isMattAutoWorkerProcess({ MATT_AUTO_ROLE: "conflict-worker" })).toBe(
      true,
    );
    expect(isMattAutoWorkerProcess({})).toBe(false);
    expect(isMattAutoWorkerProcess({ MATT_AUTO_ROLE: "home" })).toBe(false);
  });
});

describe("appendImplementationRoutingPolicy", () => {
  it("appends policy once", () => {
    const once = appendImplementationRoutingPolicy("BASE");
    expect(once).toContain("BASE");
    expect(once).toContain("Matt Auto delivery routing");
    expect(once).toContain("/matt-auto");
    const twice = appendImplementationRoutingPolicy(once);
    expect(twice).toBe(once);
  });

  it("mentions grill docs-only and multi-ticket path", () => {
    expect(IMPLEMENTATION_ROUTING_POLICY).toMatch(/Grill/i);
    expect(IMPLEMENTATION_ROUTING_POLICY).toMatch(/documentation only/i);
    expect(IMPLEMENTATION_ROUTING_POLICY).toMatch(/matt-auto run/i);
  });
});
