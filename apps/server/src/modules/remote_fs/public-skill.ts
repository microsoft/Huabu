// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const PUBLIC_ROOT_SKILL_PATTERN = /^\/api\/rfs\/[^/?]+\/skill(?:\?.*)?$/;

/** Only a credential-free root skill request may bypass the RFS auth gate. */
export function isPublicRfsSkillBootstrapRequest(input: {
  method: string;
  url: string;
  authorization?: string;
}): boolean {
  return (
    input.method === 'GET' &&
    !input.authorization &&
    PUBLIC_ROOT_SKILL_PATTERN.test(input.url)
  );
}
