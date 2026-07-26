import { describe, expect, it } from "vitest";
import {
  buildBatchedListTicketsQuery,
  chunkIssueNumbers,
  LIST_TICKETS_GRAPHQL_CHUNK,
} from "../src/adapters/tracker-queries.js";

describe("buildBatchedListTicketsQuery", () => {
  it("aliases every issue in one repository query", () => {
    const query = buildBatchedListTicketsQuery("acme", "repo", [10, 11, 12]);
    expect(query).toContain('repository(owner: "acme", name: "repo")');
    expect(query).toContain("i0: issue(number: 10)");
    expect(query).toContain("i1: issue(number: 11)");
    expect(query).toContain("i2: issue(number: 12)");
    expect(query).toContain("blockedBy(first: 50)");
    // Single query document — not one root query per issue.
    expect(query.match(/\bquery\b/g)?.length).toBe(1);
  });
});

describe("chunkIssueNumbers", () => {
  it("chunks to the GraphQL list-tickets size", () => {
    const numbers = Array.from({ length: LIST_TICKETS_GRAPHQL_CHUNK + 3 }, (_, i) => i + 1);
    const chunks = chunkIssueNumbers(numbers);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(LIST_TICKETS_GRAPHQL_CHUNK);
    expect(chunks[1]).toEqual([
      LIST_TICKETS_GRAPHQL_CHUNK + 1,
      LIST_TICKETS_GRAPHQL_CHUNK + 2,
      LIST_TICKETS_GRAPHQL_CHUNK + 3,
    ]);
  });

  it("returns empty for no issues", () => {
    expect(chunkIssueNumbers([])).toEqual([]);
  });
});
