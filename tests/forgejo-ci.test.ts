import { describe, expect, it } from "vitest";
import { createForgejoCiPort } from "../src/adapters/forgejo-ci.js";
import type {
  ForgejoApiClient,
  ForgejoRequest,
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

const SHA = "a".repeat(40);

function fakeApi(
  respond: (request: ForgejoRequest) => unknown | Promise<unknown>,
): ForgejoApiClient {
  return {
    async request<T>(request: ForgejoRequest): Promise<T> {
      return (await respond(request)) as T;
    },
    async list<T>(): Promise<readonly T[]> {
      return [];
    },
  };
}

describe("Forgejo Actions CI adapter", () => {
  it("queries Actions by the live branch SHA and returns pending", async () => {
    const api = fakeApi((request) => {
      if (request.path.endsWith("/branches/matt-auto%2F40")) {
        return { commit: { id: SHA } };
      }
      if (request.path.endsWith("/actions/runs")) {
        expect(request.query).toMatchObject({ head_sha: SHA, limit: 50 });
        return {
          workflow_runs: [
            {
              status: "running",
              title: "verify",
              html_url: "http://localhost:3002/actions/runs/4",
            },
          ],
        };
      }
      throw new Error(`Unexpected request ${request.path}`);
    });
    const ci = createForgejoCiPort(connection, { api });

    await expect(
      ci.checkStatus({ branchName: "matt-auto/40" }),
    ).resolves.toEqual({
      status: "pending",
      summary: "verify",
      url: "http://localhost:3002/actions/runs/4",
    });
  });

  it("returns failure for red Actions and success when no runs exist", async () => {
    let red = true;
    const api = fakeApi((request) => {
      if (request.path.includes("/branches/")) return { commit: { id: SHA } };
      return {
        workflow_runs: red
          ? [{ status: "failure", title: "verify" }]
          : [],
      };
    });
    const ci = createForgejoCiPort(connection, { api });

    await expect(ci.checkStatus({ branchName: "main" })).resolves.toEqual({
      status: "failure",
      summary: "verify",
    });
    red = false;
    await expect(ci.checkStatus({ branchName: "main" })).resolves.toEqual({
      status: "success",
      summary: "No Forgejo Actions runs for main.",
    });
  });

  it("fails closed when it cannot resolve the live branch", async () => {
    const api = fakeApi(() => {
      throw new Error("unauthorized");
    });
    const ci = createForgejoCiPort(connection, { api });

    await expect(ci.checkStatus({ branchName: "main" })).resolves.toMatchObject({
      status: "failure",
      summary: expect.stringMatching(/could not resolve.*unauthorized/i),
    });
  });
});
