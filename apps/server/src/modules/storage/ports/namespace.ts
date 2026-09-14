// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Extension-namespace validation.
 *
 * The namespace is the isolation token for {@link SpaceHandle.extension}, and
 * the only thing storage validates about an extension. It has to be safe as a
 * directory name on every host, and as part of an identifier in every backend
 * an adapter may later target — so the grammar is the intersection, decided
 * once here rather than per adapter.
 */

/**
 * `<owner>.<name>`, lowercase, dot-separated.
 *
 * Each segment is a letter followed by letters and digits. Deliberately narrow:
 *
 * - **An owner prefix is required.** A bare `memory` invites the collision the
 *   namespace exists to prevent; `huabu.memory` and `agenetes.acp` say whose
 *   it is. Storage cannot arbitrate a conflict it never sees the data behind.
 * - **No `_` or `-`.** A backend keyed on identifiers rather than directories
 *   has to fold the dots into something legal, and the obvious fold is `_`.
 *   Allowing `_` in a namespace would make that fold ambiguous — `a.b` and
 *   `a_b` would land in the same place — so the character is reserved.
 * - **Lowercase only.** Case-insensitive filesystems and case-folding
 *   identifier rules would otherwise let two namespaces that look distinct
 *   share one directory or one table.
 */
const NAMESPACE_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

/** Bounded so a namespace stays inside identifier-length limits with room for
 * an owner's own suffixes. */
const MAX_NAMESPACE_LENGTH = 64;

export class SpaceNamespaceError extends Error {
  override name = 'SpaceNamespaceError';
}

/** Validate an extension namespace, returning it unchanged. */
export function assertValidNamespace(namespace: string): string {
  if (namespace.length > MAX_NAMESPACE_LENGTH) {
    throw new SpaceNamespaceError(
      `Extension namespace is longer than ${MAX_NAMESPACE_LENGTH} characters: ` +
        `${JSON.stringify(namespace)}`,
    );
  }
  if (!NAMESPACE_RE.test(namespace)) {
    throw new SpaceNamespaceError(
      `Extension namespace ${JSON.stringify(namespace)} is not of the form ` +
        '"<owner>.<name>" in lowercase letters and digits (e.g. "huabu.memory").',
    );
  }
  return namespace;
}
