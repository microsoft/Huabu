// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { PeopleSettings } from './PeopleSettings';

const mocks = vi.hoisted(() => ({
  listPeople: vi.fn(),
  setPersonMember: vi.fn(),
}));

// A stable `t`, as react-i18next gives: the list reloads when `t` changes.
const translation = { t: (key: string) => key };
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));
vi.mock('../../../api/people', () => ({
  listPeople: mocks.listPeople,
  setPersonMember: mocks.setPersonMember,
  setPersonWorkspaceRole: vi.fn(),
  resetPersonDeviceCredentials: vi.fn(),
}));
vi.mock('../../../api/workspace', () => ({
  listWorkspaces: async () => [],
}));
vi.mock('../../../store/identityStore', () => ({
  useIdentityStore: (select: (state: unknown) => unknown) =>
    select({ identity: { principal: { principalId: 'admin' } } }),
}));
vi.mock('../../Common/Toast', () => ({ toast: vi.fn() }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

const person = (
  principalId: string,
  standing: { admin?: boolean; member?: boolean },
) => ({
  principal: { principalId, displayName: principalId, email: null },
  admin: standing.admin ?? false,
  member: standing.member ?? false,
  workspaces: [],
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.listPeople.mockResolvedValue([
    person('admin', { admin: true }),
    person('carol', { member: true }),
    person('dave', {}),
  ]);
  mocks.setPersonMember.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<PeopleSettings />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('labels the access switch and shows where each person stands', async () => {
  const rows = Array.from(container.querySelectorAll('li'));
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining('people.status.administrator'),
    expect.stringContaining('people.status.admitted'),
    expect.stringContaining('people.status.waiting'),
  ]);
  expect(container.textContent).toContain('people.accessVsWorkspace');

  const waiting = container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="people.serviceAccess: dave"]',
  );
  expect(waiting?.getAttribute('aria-checked')).toBe('false');
  expect(waiting?.parentElement?.textContent).toContain('people.serviceAccess');
  await act(async () => waiting?.click());
  expect(mocks.setPersonMember).toHaveBeenCalledExactlyOnceWith('dave', true);
});
