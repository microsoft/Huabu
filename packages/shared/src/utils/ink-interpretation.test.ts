// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  readInkInterpretation,
  settleInkInterpretation,
} from './ink-interpretation.js';
import {
  inkIntentReportSchema,
  inkInterpretationSchema,
} from '../types/api/agent.js';

describe('Ink interpretation contracts', () => {
  it('normalizes canonical success envelopes and preserves explicit report failures', () => {
    const data = {
      text: 'Initial understanding',
      explanation: 'A detail is uncertain.',
      renamed: false,
    };
    const wrapped = { tool: 'report_ink_intent', status: 'success', data };
    expect(readInkInterpretation(wrapped)).toEqual(readInkInterpretation(data));
    expect(readInkInterpretation(JSON.stringify(wrapped))).toEqual(
      readInkInterpretation(data),
    );
    expect(
      readInkInterpretation({
        tool: 'report_ink_intent',
        status: 'error',
        error: 'Report rejected',
      }),
    ).toEqual({ state: 'failed' });
    expect(
      readInkInterpretation({
        tool: 'another_tool',
        status: 'success',
        data,
      }),
    ).toBeUndefined();
  });

  it.each([
    { text: '  Explain the diagram  ' },
    {
      text: 'Adjust the layout',
      explanation: '  The exact position is unclear.  ',
    },
    { text: 'x'.repeat(120), explanation: 'x'.repeat(600) },
  ])(
    'normalizes new reports consistently across writer and readers: %j',
    (input) => {
      const report = inkIntentReportSchema.parse(input);
      expect(readInkInterpretation(input)).toEqual({
        state: 'reported',
        ...report,
      });
      expect(
        inkInterpretationSchema.parse(readInkInterpretation(input)),
      ).toEqual({
        state: 'reported',
        ...report,
      });
    },
  );

  it.each([
    {},
    { text: '' },
    { text: ' ' },
    { text: 'x'.repeat(121) },
    { text: 'one\ntwo' },
    { text: 'one\rtwo' },
    { text: 1 },
    { text: 'Summary', explanation: '' },
    { text: 'Summary', explanation: 2 },
    { text: 'Summary', explanation: 'x'.repeat(601) },
  ])('rejects invalid report content: %j', (input) => {
    expect(inkIntentReportSchema.safeParse(input).success).toBe(false);
    expect(readInkInterpretation(input)).toBeUndefined();
  });

  it('rejects semantic fields on new writes while reading old records honestly', () => {
    const old = { status: 'inferred', text: 'The old interpretation' };
    expect(inkIntentReportSchema.safeParse(old).success).toBe(false);
    expect(readInkInterpretation(JSON.stringify(old))).toEqual({
      state: 'reported',
      text: old.text,
    });
    for (const status of ['clarify', 'unsupported']) {
      expect(inkIntentReportSchema.safeParse({ status }).success).toBe(false);
      expect(readInkInterpretation({ status })).toEqual({ state: 'legacy' });
    }
    expect(readInkInterpretation('{invalid')).toBeUndefined();
    expect(
      readInkInterpretation({ status: 'other', text: 'Not a report' }),
    ).toBeUndefined();
  });

  it('settles only unfinished delivery and never erases a received interpretation', () => {
    expect(settleInkInterpretation(undefined, 'done')).toEqual({
      state: 'missing',
    });
    expect(settleInkInterpretation({ state: 'pending' }, 'error')).toEqual({
      state: 'failed',
    });
    expect(
      settleInkInterpretation({ state: 'pending' }, 'interrupted'),
    ).toEqual({ state: 'interrupted' });
    const report = {
      state: 'reported' as const,
      text: 'Summary',
      explanation: 'Uncertainty',
    };
    expect(settleInkInterpretation(report, 'error')).toBe(report);
    expect(settleInkInterpretation(report, 'interrupted')).toBe(report);
  });
});
