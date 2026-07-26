/**
 * Pure helpers for batched GitHub tracker queries (fewer GraphQL round-trips).
 */

/** Max issues per GraphQL request to keep payloads bounded. */
export const LIST_TICKETS_GRAPHQL_CHUNK = 20;

/**
 * Build one repository query with aliased `issue(number:)` fields so many
 * tickets load in a single `gh api graphql` call.
 */
export function buildBatchedListTicketsQuery(
  owner: string,
  name: string,
  issueNumbers: readonly number[],
): string {
  const fields = issueNumbers
    .map((number, index) => {
      return (
        `i${index}: issue(number: ${number}) {\n` +
        `  number\n` +
        `  title\n` +
        `  state\n` +
        `  blockedBy(first: 50) {\n` +
        `    nodes { number state }\n` +
        `  }\n` +
        `}`
      );
    })
    .join("\n");

  return (
    `query {\n` +
    `  repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n` +
    `${fields}\n` +
    `  }\n` +
    `}`
  );
}

export function chunkIssueNumbers(
  issueNumbers: readonly number[],
  chunkSize: number = LIST_TICKETS_GRAPHQL_CHUNK,
): number[][] {
  if (issueNumbers.length === 0) return [];
  const size = Math.max(1, chunkSize);
  const chunks: number[][] = [];
  for (let i = 0; i < issueNumbers.length; i += size) {
    chunks.push([...issueNumbers.slice(i, i + size)]);
  }
  return chunks;
}
