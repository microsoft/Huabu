import { beforeEach, describe, expect, it } from 'vitest';

import { RESOURCE_GRANT_ENV } from '@huabu/shared';

import {
  acquireInvocation,
  authorizeResourceGrant,
  issueResourceGrant,
  resetResourceGrantsForTests,
} from './resource-grant.js';

function issue() {
  return issueResourceGrant({
    agentletId: 'machine-a',
    profileId: 'profile-a',
    canvasId: 'canvas-a',
    threadId: 'thread-a',
    allowedResourceIds: ['web-search', 'generate-image'],
  })[RESOURCE_GRANT_ENV];
}

beforeEach(() => resetResourceGrantsForTests());

describe('resource grants', () => {
  it('binds an opaque runtime token to its trusted scope', () => {
    const token = issue();

    expect(
      authorizeResourceGrant(token, 'canvas-a', 'web-search'),
    ).toMatchObject({
      agentletId: 'machine-a',
      profileId: 'profile-a',
      canvasId: 'canvas-a',
      threadId: 'thread-a',
      policyVersion: 1,
    });
  });

  it('rejects absent tokens, other canvases, and unselected resources', () => {
    const token = issue();

    expect(() =>
      authorizeResourceGrant(undefined, 'canvas-a', 'web-search'),
    ).toThrow(/required/);
    expect(() =>
      authorizeResourceGrant(token, 'canvas-b', 'web-search'),
    ).toThrow(/does not allow/);
    expect(() =>
      authorizeResourceGrant(token, 'canvas-a', 'other-resource'),
    ).toThrow(/does not allow/);
  });

  it('enforces sequential image generation per grant', () => {
    const token = issue();
    const release = acquireInvocation(token, 'generate-image');

    expect(() => acquireInvocation(token, 'generate-image')).toThrow(
      /concurrency limit/,
    );
    release();
    expect(() => acquireInvocation(token, 'generate-image')).not.toThrow();
  });

  it('revokes the previous grant when the same workload scope resumes', () => {
    const previousToken = issue();
    const nextToken = issue();

    expect(nextToken).not.toBe(previousToken);
    expect(() =>
      authorizeResourceGrant(previousToken, 'canvas-a', 'web-search'),
    ).toThrow(/invalid or expired/);
    expect(() =>
      authorizeResourceGrant(nextToken, 'canvas-a', 'web-search'),
    ).not.toThrow();
  });
});
