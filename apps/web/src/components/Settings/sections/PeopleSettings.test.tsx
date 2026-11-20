// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { PeopleSettings } from './PeopleSettings';

const mocks = vi.hoisted(() => ({
  listPeople: vi.fn(),
  setPersonMember: vi.fn(),
  getAdmission: vi.fn(),
  setAutomaticAdmission: vi.fn(),
}));

// A stable `t`, as react-i18next gives: the list reloads when `t` changes.
// Interpolated values follow the key, so a test can see what was passed.
const translation = {
  t: (key: string, options?: Record<string, unknown>) =>
    options ? `${key}(${Object.values(options).join('|')})` : key,
};
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));
vi.mock('../../../api/people', () => ({
  listPeople: mocks.listPeople,
  setPersonMember: mocks.setPersonMember,
  getAdmission: mocks.getAdmission,
  setAutomaticAdmission: mocks.setAutomaticAdmission,
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
  standing: {
    admin?: boolean;
    member?: boolean;
    joinedAutomatically?: boolean;
    blocked?: boolean;
  },
) => ({
  principal: { principalId, displayName: principalId, email: null },
  admin: standing.admin ?? false,
  member: standing.member ?? false,
  joinedAutomatically: standing.joinedAutomatically ?? false,
  blocked: standing.blocked ?? false,
  workspaces: [],
});

async function render() {
  await act(async () => root.render(<PeopleSettings />));
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.listPeople.mockResolvedValue([
    person('admin', { admin: true }),
    person('carol', { member: true }),
    person('dave', {}),
  ]);
  mocks.setPersonMember.mockResolvedValue(undefined);
  mocks.getAdmission.mockResolvedValue({
    automatic: false,
    providers: ['entra', 'auth0'],
  });
  mocks.setAutomaticAdmission.mockResolvedValue({
    automatic: true,
    providers: ['entra', 'auth0'],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await render();
});

const automaticSwitch = () =>
  container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="people.admission.title"]',
  );

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

it('turns automatic admission on, naming the providers it applies to', async () => {
  const toggle = automaticSwitch();
  expect(toggle?.getAttribute('aria-checked')).toBe('false');
  expect(toggle?.disabled).toBe(false);
  // Each configured provider is named, in order, so the copy never promises
  // a tenant boundary Auth0 does not have.
  expect(container.textContent).toContain(
    'people.admission.description(people.admission.provider.entra' +
      'people.admission.providerSeparatorpeople.admission.provider.auth0)',
  );

  mocks.getAdmission.mockResolvedValue({
    automatic: true,
    providers: ['entra', 'auth0'],
  });
  await act(async () => toggle?.click());
  expect(mocks.setAutomaticAdmission).toHaveBeenCalledExactlyOnceWith(true);
  expect(automaticSwitch()?.getAttribute('aria-checked')).toBe('true');
});

it('offers no switch to turn on when no identity provider is configured', async () => {
  mocks.getAdmission.mockResolvedValue({ automatic: false, providers: [] });
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(automaticSwitch()?.disabled).toBe(true);
  expect(container.textContent).toContain('people.admission.noProviders');
});

it('marks who joined automatically and whose access was removed', async () => {
  mocks.listPeople.mockResolvedValue([
    person('admin', { admin: true }),
    person('erin', { member: true, joinedAutomatically: true }),
    person('carol', { member: true }),
    person('ivan', { blocked: true }),
    person('dave', {}),
  ]);
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  const row = (name: string) =>
    Array.from(container.querySelectorAll('li')).find((li) =>
      li.textContent?.startsWith(name),
    )?.textContent ?? '';
  expect(row('erin')).toContain('people.status.admitted');
  expect(row('erin')).toContain('people.status.joinedAutomatically');
  expect(row('carol')).toContain('people.status.admitted');
  expect(row('carol')).not.toContain('people.status.joinedAutomatically');
  expect(row('ivan')).toContain('people.status.blocked');
  expect(row('ivan')).not.toContain('people.status.waiting');
  expect(row('dave')).toContain('people.status.waiting');

  // Turning a removed person's access back on is the ordinary switch.
  const blocked = container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="people.serviceAccess: ivan"]',
  );
  expect(blocked?.getAttribute('aria-checked')).toBe('false');
  await act(async () => blocked?.click());
  expect(mocks.setPersonMember).toHaveBeenCalledExactlyOnceWith('ivan', true);
});
