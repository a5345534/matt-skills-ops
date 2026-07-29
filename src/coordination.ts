import type {
  CanonicalRepositoryIdentity,
  CanonicalTargetIdentity,
} from "./types.js";

const HEADS_REF_PREFIX = "refs/heads/";
const GITHUB_NAME_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const INVALID_BRANCH_CHARACTER = /[\x00-\x20~^:?*\[\\]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGitHubNameSegment(value: unknown): value is string {
  return typeof value === "string" && GITHUB_NAME_SEGMENT.test(value);
}

function isValidBranchName(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "@" &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("//") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.split("/").some((component) => component.endsWith(".lock")) &&
    !INVALID_BRANCH_CHARACTER.test(value)
  );
}

/**
 * Runtime validation for the GitHub owner/name identity used for coordination.
 * It deliberately excludes paths, remote aliases, and whitespace.
 */
export function isCanonicalRepositoryIdentity(
  value: unknown,
): value is CanonicalRepositoryIdentity {
  if (!isRecord(value)) return false;
  return isGitHubNameSegment(value.owner) && isGitHubNameSegment(value.name);
}

/** Whether a value is a fully qualified branch ref suitable for Target identity. */
export function isFullyQualifiedTargetRef(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(HEADS_REF_PREFIX)) {
    return false;
  }
  return isValidBranchName(value.slice(HEADS_REF_PREFIX.length));
}

/** Validate a canonical repository plus fully qualified Target ref. */
export function isCanonicalTargetIdentity(
  value: unknown,
): value is CanonicalTargetIdentity {
  if (!isRecord(value)) return false;
  return (
    isCanonicalRepositoryIdentity(value.repository) &&
    isFullyQualifiedTargetRef(value.targetRef)
  );
}

/**
 * Convert a legacy bare Target branch name into its canonical branch ref.
 * Fully qualified refs are intentionally rejected to keep the representation unambiguous.
 */
export function targetRefFromBranch(targetBranch: string): string | undefined {
  if (
    targetBranch.startsWith("refs/") ||
    !isValidBranchName(targetBranch)
  ) {
    return undefined;
  }
  return `${HEADS_REF_PREFIX}${targetBranch}`;
}

/** Return the legacy bare branch name represented by a canonical Target ref. */
export function targetBranchFromRef(targetRef: string): string | undefined {
  if (!isFullyQualifiedTargetRef(targetRef)) return undefined;
  return targetRef.slice(HEADS_REF_PREFIX.length);
}

/** Stable comparison key for a GitHub repository identity. */
export function canonicalRepositoryIdentityKey(
  repository: CanonicalRepositoryIdentity,
): string {
  return `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
}

/** Stable comparison key for a canonical repository and Target ref. */
export function canonicalTargetIdentityKey(
  target: CanonicalTargetIdentity,
): string {
  return `${canonicalRepositoryIdentityKey(target.repository)}:${target.targetRef}`;
}

/** Compare canonical Target identities without relying on a local clone or remote alias. */
export function canonicalTargetIdentitiesEqual(
  left: CanonicalTargetIdentity,
  right: CanonicalTargetIdentity,
): boolean {
  return canonicalTargetIdentityKey(left) === canonicalTargetIdentityKey(right);
}
