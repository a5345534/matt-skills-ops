import { describe, expect, it, vi } from "vitest";
import {
  createForgejoApiClient,
  ForgejoApiError,
} from "../src/adapters/forgejo-api.js";
import type { ForgejoConnection } from "../src/adapters/forge.js";

const connection: ForgejoConnection = {
  provider: "forgejo",
  baseUrl: "http://localhost:3002",
  owner: "a5345534",
  name: "matt-skills-ops",
  remoteName: "origin",
  tokenEnv: "MATT_AUTO_FORGEJO_TOKEN",
};

describe("ForgejoApiClient", () => {
  it("uses the Forgejo API URL, JSON body, and token header without leaking the token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ number: 42 }), { status: 201 }),
    );
    const api = createForgejoApiClient(connection, {
      fetch,
      token: async () => "secret-token",
    });

    await expect(
      api.request<{ number: number }>({
        method: "POST",
        path: "/repos/a5345534/matt-skills-ops/issues",
        query: { state: "open" },
        body: { title: "Workflow" },
      }),
    ).resolves.toEqual({ number: 42 });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "http://localhost:3002/api/v1/repos/a5345534/matt-skills-ops/issues?state=open",
    );
    expect(init?.headers).toMatchObject({
      Authorization: "token secret-token",
      "Content-Type": "application/json",
    });
    expect(init?.body).toBe(JSON.stringify({ title: "Workflow" }));
  });

  it("fails before an authenticated request when no token is configured", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = createForgejoApiClient(connection, {
      fetch,
      token: async () => undefined,
    });

    await expect(api.request({ path: "/user" })).rejects.toThrow(
      /authentication is not configured/i,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces Forgejo error bodies without including its authorization token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "permission denied" }), { status: 403 }),
    );
    const api = createForgejoApiClient(connection, {
      fetch,
      token: async () => "not-for-errors",
    });

    try {
      await api.request({ path: "/repos/a5345534/matt-skills-ops" });
      throw new Error("Expected API call to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ForgejoApiError);
      expect(String(error)).toMatch(/403.*permission denied/i);
      expect(String(error)).not.toContain("not-for-errors");
    }
  });

  it("paginates array endpoints through the final short page", async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({ id: index + 1 }));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(first), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 51 }]), { status: 200 }),
      );
    const api = createForgejoApiClient(connection, {
      fetch,
      token: async () => "token",
    });

    await expect(api.list<{ id: number }>({ path: "/things" })).resolves.toEqual(
      [...first, { id: 51 }],
    );
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/[?&]page=1/);
    expect(String(fetch.mock.calls[1]?.[0])).toMatch(/[?&]page=2/);
  });
});
