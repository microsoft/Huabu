// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { fitSpaceAgentCount } from './useSpaceAgentFit';

it('fits exact widths, reserving overflow only when sessions remain', () => {
  expect(fitSpaceAgentCount(147, [100, 100], [40], 8)).toBe(0);
  expect(fitSpaceAgentCount(148, [100, 100], [40], 8)).toBe(1);
  expect(fitSpaceAgentCount(207, [100, 100], [40], 8)).toBe(1);
  expect(fitSpaceAgentCount(208, [100, 100], [40], 8)).toBe(2);
  expect(fitSpaceAgentCount(188, [170, 10], [40], 8)).toBe(2);
  expect(fitSpaceAgentCount(100, [100], [40], 8)).toBe(1);
});

it('handles fractional widths, count digit changes, empty and narrow rows', () => {
  expect(fitSpaceAgentCount(148.4, [100.5, 100], [40], 8)).toBe(0);
  expect(fitSpaceAgentCount(148.5, [100.5, 100], [40], 8)).toBe(1);
  expect(fitSpaceAgentCount(148, Array(10).fill(100), [40, 50], 8)).toBe(1);
  expect(fitSpaceAgentCount(148, Array(11).fill(100), [40, 50], 8)).toBe(0);
  expect(fitSpaceAgentCount(158, Array(11).fill(100), [40, 50], 8)).toBe(1);
  expect(fitSpaceAgentCount(0, [100], [40], 8)).toBe(0);
  expect(fitSpaceAgentCount(500, [], [], 8)).toBe(0);
  expect(fitSpaceAgentCount(1000, Array(8).fill(100), [40], 8)).toBe(8);
});
