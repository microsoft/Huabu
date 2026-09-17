// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  extractTitleFromText,
  normalizeAcpConversationTitle,
  normalizeConversationTitle,
} from './conversation-title.js';

const promptLikeTitle =
  'You are a helpful assistant collaborating with a user inside **Huabu**, an infinite visual Space. The user works on an i';

describe('conversation title normalization', () => {
  it.each([
    ['', undefined],
    [' \n\t ', undefined],
    ['# **Research plan**', 'Research plan'],
    ['Intro\n## Specific topic', 'Specific topic'],
    ['\r\nFirst line\r\nSecond line', 'First line'],
    ['> - **Topic** and `code`', 'Topic and code'],
    ['[Link](https://example.com) and ![image](image.png)', 'Link and image'],
    ['A'.repeat(80), 'A'.repeat(50)],
  ])('extracts the shared fallback from %j', (input, expected) => {
    expect(extractTitleFromText(input as string)).toBe(expected);
  });

  it('preserves host/manual normalization and truncation semantics', () => {
    expect(normalizeConversationTitle(' \n A  useful\t title ')).toBe(
      'A useful title',
    );
    expect(normalizeConversationTitle('x'.repeat(121))).toHaveLength(120);
    expect(normalizeConversationTitle(promptLikeTitle)).toBe(promptLikeTitle);
  });

  it.each([undefined, null, 1, {}, '', ' \n '])(
    'rejects empty/non-string titles: %j',
    (value) => {
      expect(normalizeConversationTitle(value)).toBeNull();
      expect(normalizeAcpConversationTitle(value)).toBeNull();
    },
  );

  it.each([
    promptLikeTitle,
    promptLikeTitle.replace(/\*\*/g, ''),
    promptLikeTitle.replace(/\*\*/g, '__'),
    promptLikeTitle.replace(/\*\*/g, '`'),
    '> **You are a helpful assistant collaborating with a user inside Huabu**, an infinite visual Space.',
    '# You are a helpful assistant collaborating with a user inside **Huabu**',
    '“You are a helpful assistant collaborating with a user inside Huabu, an infinite visual Space.”',
    'YOU ARE A HELPFUL ASSISTANT COLLABORATING WITH A USER INSIDE HUABU',
  ])('accepts prompt-like text without prefix filtering: %s', (value) => {
    expect(normalizeAcpConversationTitle(value)).toBe(
      value.replace(/\s+/g, ' ').trim(),
    );
  });

  it('rejects overlong normalized ACP values rather than converting prose into a title', () => {
    expect(normalizeAcpConversationTitle('x'.repeat(121))).toBeNull();
    expect(normalizeAcpConversationTitle('x'.repeat(120))).toBe(
      'x'.repeat(120),
    );
    expect(normalizeAcpConversationTitle(`  ${'x'.repeat(120)}\t `)).toBe(
      'x'.repeat(120),
    );
  });

  it.each([
    'A useful\ntitle',
    'A useful\rtitle',
    'A useful\r\ntitle',
    ` \n${'x'.repeat(120)}\t `,
  ])('rejects multiline ACP values: %j', (value) => {
    expect(normalizeAcpConversationTitle(value)).toBeNull();
  });

  it.each([
    'A useful title',
    'You are a helpful assistant',
    'You are a helpful assistant collaborating with a user inside another app',
    'You are a helpful assistant collaborating with a user inside HuabuTools',
    'Discuss the Huabu system prompt',
    'The user works on an infinite Space',
  ])(
    'does not guess from generic assistant or product language: %s',
    (value) => {
      expect(normalizeAcpConversationTitle(`  ${value}\t `)).toBe(value);
    },
  );
});
