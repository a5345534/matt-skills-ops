import {
  resolveForgejoToken,
  type ForgejoConnection,
} from "./forge.js";

export type ForgejoQueryValue =
  | string
  | number
  | boolean
  | readonly (string | number | boolean)[]
  | undefined;

export type ForgejoRequest = {
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  path: string;
  query?: Readonly<Record<string, ForgejoQueryValue>>;
  body?: unknown;
  /** Defaults to true; only public probes such as /version should disable it. */
  authenticate?: boolean;
};

export class ForgejoApiError extends Error {
  readonly status: number | undefined;
  readonly path: string;

  constructor(input: { message: string; path: string; status?: number }) {
    super(input.message);
    this.name = "ForgejoApiError";
    this.path = input.path;
    this.status = input.status;
  }
}

export type ForgejoApiClient = {
  request<T>(input: ForgejoRequest): Promise<T>;
  list<T>(input: Omit<ForgejoRequest, "query"> & {
    query?: Readonly<Record<string, ForgejoQueryValue>>;
  }): Promise<readonly T[]>;
};

export type ForgejoApiClientOptions = {
  fetch?: typeof fetch;
  token?: () => Promise<string | undefined>;
  timeoutMs?: number;
};

function apiUrl(
  baseUrl: string,
  apiPath: string,
  query: Readonly<Record<string, ForgejoQueryValue>> | undefined,
): string {
  const url = new URL(
    `${baseUrl}/api/v1/${apiPath.replace(/^\/+/, "")}`,
  );
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) url.searchParams.append(key, String(entry));
  }
  return url.toString();
}

function summarizeResponseBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { message?: unknown }).message === "string"
    ) {
      return (parsed as { message: string }).message.trim();
    }
  } catch {
    // Fall through to a bounded raw body snippet.
  }
  return trimmed.slice(0, 800);
}

function isSuccessful(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Small, provider-owned Forgejo REST client. It keeps authentication local to
 * the adapter boundary and includes no token in errors, manifest data, or logs.
 */
export function createForgejoApiClient(
  connection: ForgejoConnection,
  options: ForgejoApiClientOptions = {},
): ForgejoApiClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const resolveToken = options.token ?? (() => resolveForgejoToken(connection));
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function request<T>(input: ForgejoRequest): Promise<T> {
    const method = input.method ?? "GET";
    const authenticate = input.authenticate !== false;
    const token = authenticate ? await resolveToken() : undefined;
    if (authenticate && !token) {
      throw new ForgejoApiError({
        path: input.path,
        status: 401,
        message:
          `Forgejo authentication is not configured for ${connection.baseUrl}. ` +
          `Set ${connection.tokenEnv} or configure tokenFile in .pi/matt-auto/forge.json.`,
      });
    }

    let response: Response;
    try {
      response = await fetchImpl(apiUrl(connection.baseUrl, input.path, input.query), {
        method,
        headers: {
          Accept: "application/json",
          ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `token ${token}` } : {}),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ForgejoApiError({
        path: input.path,
        message: `Forgejo API request ${method} ${input.path} failed: ${message}`,
      });
    }

    const text = await response.text();
    if (!isSuccessful(response.status)) {
      const detail = summarizeResponseBody(text);
      throw new ForgejoApiError({
        path: input.path,
        status: response.status,
        message:
          `Forgejo API ${method} ${input.path} returned HTTP ${response.status}` +
          (detail ? `: ${detail}` : ""),
      });
    }
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ForgejoApiError({
        path: input.path,
        status: response.status,
        message: `Forgejo API ${method} ${input.path} returned non-JSON output.`,
      });
    }
  }

  async function list<T>(
    input: Omit<ForgejoRequest, "query"> & {
      query?: Readonly<Record<string, ForgejoQueryValue>>;
    },
  ): Promise<readonly T[]> {
    const limit = 50;
    const entries: T[] = [];
    // Forgejo exposes page + limit on collection endpoints. A hard cap guards
    // against a faulty server returning full duplicate pages forever.
    for (let page = 1; page <= 10_000; page += 1) {
      const response = await request<unknown>({
        ...input,
        query: { ...(input.query ?? {}), page, limit },
      });
      if (!Array.isArray(response)) {
        throw new ForgejoApiError({
          path: input.path,
          message: `Forgejo API ${input.path} returned a non-array page.`,
        });
      }
      entries.push(...(response as T[]));
      if (response.length < limit) return entries;
    }
    throw new ForgejoApiError({
      path: input.path,
      message: `Forgejo API ${input.path} exceeded the pagination safety limit.`,
    });
  }

  return { request, list };
}
