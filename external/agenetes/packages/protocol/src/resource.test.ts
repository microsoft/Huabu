import { describe, expect, it } from 'vitest';

import {
  AGENT_RESOURCE_SCHEMA_VERSION,
  MAX_PROFILE_RESOURCE_IDS,
  agentResourceSchema,
  resourceIdListSchema,
  resourceIdSchema,
  resourceIdsOverrideSchema,
} from './resource.js';

const validResource = {
  schemaVersion: AGENT_RESOURCE_SCHEMA_VERSION,
  id: 'huabu-access',
  name: 'Huabu Access',
  provider: 'huabu',
  sourceContent: 'Fetch $HUABU_RFS_URL/skill with the injected Agentlet token.',
  userContent: '',
};

describe('resourceIdSchema', () => {
  it('accepts a lowercase kebab-case id', () => {
    expect(resourceIdSchema.parse('huabu-access')).toBe('huabu-access');
  });

  it('trims surrounding whitespace', () => {
    expect(resourceIdSchema.parse('  huabu-access  ')).toBe('huabu-access');
  });

  it('rejects an empty id', () => {
    expect(resourceIdSchema.safeParse('').success).toBe(false);
  });

  it('rejects uppercase or non-kebab-case ids', () => {
    expect(resourceIdSchema.safeParse('Huabu-Access').success).toBe(false);
    expect(resourceIdSchema.safeParse('huabu_access').success).toBe(false);
    expect(resourceIdSchema.safeParse('huabu access').success).toBe(false);
  });

  it('rejects an id past the bound length', () => {
    expect(resourceIdSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
});

describe('resourceIdListSchema', () => {
  it('accepts an empty and a populated list', () => {
    expect(resourceIdListSchema.parse([])).toEqual([]);
    expect(resourceIdListSchema.parse(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('rejects duplicate ids', () => {
    const result = resourceIdListSchema.safeParse(['a', 'a']);
    expect(result.success).toBe(false);
  });

  it('rejects a list past the bound', () => {
    const ids = Array.from(
      { length: MAX_PROFILE_RESOURCE_IDS + 1 },
      (_, i) => `r-${i}`,
    );
    expect(resourceIdListSchema.safeParse(ids).success).toBe(false);
  });

  it('accepts a list at exactly the bound', () => {
    const ids = Array.from(
      { length: MAX_PROFILE_RESOURCE_IDS },
      (_, i) => `r-${i}`,
    );
    expect(resourceIdListSchema.safeParse(ids).success).toBe(true);
  });
});

describe('agentResourceSchema', () => {
  it('accepts a minimal valid record', () => {
    expect(agentResourceSchema.parse(validResource)).toEqual(validResource);
  });

  it('rejects an unsupported schemaVersion', () => {
    expect(
      agentResourceSchema.safeParse({ ...validResource, schemaVersion: 1 })
        .success,
    ).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { sourceContent: _sourceContent, ...withoutSourceContent } =
      validResource;
    expect(agentResourceSchema.safeParse(withoutSourceContent).success).toBe(
      false,
    );
  });

  it('rejects empty source content', () => {
    expect(
      agentResourceSchema.safeParse({ ...validResource, sourceContent: '' })
        .success,
    ).toBe(false);
  });

  it('accepts an optional display name and global user content', () => {
    expect(
      agentResourceSchema.parse({
        ...validResource,
        displayName: 'Canvas helper',
        userContent: 'Prefer bounded queries.',
      }),
    ).toMatchObject({
      displayName: 'Canvas helper',
      userContent: 'Prefer bounded queries.',
    });
  });

  it('rejects a non-kebab-case id', () => {
    expect(
      agentResourceSchema.safeParse({ ...validResource, id: 'Huabu Access' })
        .success,
    ).toBe(false);
  });
});

describe('resourceIdsOverrideSchema', () => {
  it('accepts an absent resourceIds field (no override)', () => {
    expect(resourceIdsOverrideSchema.parse({})).toEqual({});
  });

  it('accepts an explicit empty list (replace with none)', () => {
    expect(resourceIdsOverrideSchema.parse({ resourceIds: [] })).toEqual({
      resourceIds: [],
    });
  });

  it('accepts an explicit populated list (full replacement)', () => {
    expect(
      resourceIdsOverrideSchema.parse({ resourceIds: ['web-search'] }),
    ).toEqual({ resourceIds: ['web-search'] });
  });

  it('rejects duplicate ids in the override', () => {
    expect(
      resourceIdsOverrideSchema.safeParse({
        resourceIds: ['web-search', 'web-search'],
      }).success,
    ).toBe(false);
  });
});
