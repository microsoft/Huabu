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

// A stable `t`, as react-i18next gives: the list reloads when `t` changes,
// as on a language change, which a test does by replacing `translation`.
// Interpolated values follow the key, so a test can see what was passed.
const translate = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${Object.values(options).join('|')})` : key;
let translation = { t: translate };
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

/** A promise the test settles when it chooses. */
function held<T>() {
  let settle!: (value: T) => void;
  let fail!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

beforeEach(async () => {
  vi.clearAllMocks();
  translation = { t: translate };
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
  expect(container.textContent).toContain('people.admission.keepsRemoved');

  mocks.getAdmission.mockResolvedValue({
    automatic: true,
    providers: ['entra', 'auth0'],
  });
  await act(async () => toggle?.click());
  expect(mocks.setAutomaticAdmission).toHaveBeenCalledExactlyOnceWith(true);
  expect(automaticSwitch()?.getAttribute('aria-checked')).toBe('true');
});

it('shows the saved admission setting even when the refresh after it fails', async () => {
  mocks.listPeople.mockRejectedValue(new Error('People unavailable'));
  mocks.getAdmission.mockRejectedValue(new Error('Admission unavailable'));
  await act(async () => automaticSwitch()?.click());
  expect(mocks.setAutomaticAdmission).toHaveBeenCalledExactlyOnceWith(true);
  expect(automaticSwitch()?.getAttribute('aria-checked')).toBe('true');
  // So the next click turns it off rather than sending `true` again.
  mocks.setAutomaticAdmission.mockResolvedValue({
    automatic: false,
    providers: ['entra', 'auth0'],
  });
  await act(async () => automaticSwitch()?.click());
  expect(mocks.setAutomaticAdmission).toHaveBeenLastCalledWith(false);
});

it('keeps the saved admission setting when an older refresh answers last', async () => {
  // A language change reloads People; its admission read is slow and still
  // carries the setting from before the save.
  const older = held<{ automatic: boolean; providers: string[] }>();
  mocks.getAdmission.mockReturnValueOnce(older.promise);
  translation = { t: (key, options) => translate(key, options) };
  await render();
  expect(mocks.getAdmission).toHaveBeenCalledTimes(2);

  mocks.getAdmission.mockResolvedValue({
    automatic: true,
    providers: ['entra', 'auth0'],
  });
  await act(async () => automaticSwitch()?.click());
  expect(automaticSwitch()?.getAttribute('aria-checked')).toBe('true');
  await act(async () =>
    older.settle({ automatic: false, providers: ['entra', 'auth0'] }),
  );
  expect(automaticSwitch()?.getAttribute('aria-checked')).toBe('true');
  // So the next click turns it off rather than sending `true` again.
  await act(async () => automaticSwitch()?.click());
  expect(mocks.setAutomaticAdmission).toHaveBeenLastCalledWith(false);
});

it('lists people before the admission setting answers', async () => {
  const pending = held<never>();
  mocks.getAdmission.mockReturnValue(pending.promise);
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.textContent).not.toContain('people.loading');
  const dave = Array.from(container.querySelectorAll('li')).find((li) =>
    li.textContent?.startsWith('dave'),
  );
  expect(dave?.textContent).toContain('people.resetDevices');
  // The switch waits for the setting rather than guessing it.
  expect(automaticSwitch()).toBeNull();
  await act(async () => pending.fail(new Error('Admission unavailable')));
  expect(container.textContent).toContain('people.admission.loadFailed');
});

it('re-enables every control after a change while the admission read stalls', async () => {
  mocks.getAdmission.mockReturnValue(held<never>().promise);
  const dave = () =>
    container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="people.serviceAccess: dave"]',
    );
  await act(async () => dave()?.click());
  expect(mocks.setPersonMember).toHaveBeenCalledExactlyOnceWith('dave', true);
  expect(dave()?.disabled).toBe(false);
  // So the owner can still turn automatic admission off, or on.
  expect(automaticSwitch()?.disabled).toBe(false);
  await act(async () => automaticSwitch()?.click());
  expect(mocks.setAutomaticAdmission).toHaveBeenCalledExactlyOnceWith(true);
  expect(automaticSwitch()?.getAttribute('aria-checked')).toBe('true');
});

it('lists people and their device reset when the admission setting cannot load', async () => {
  mocks.getAdmission.mockRejectedValue(new Error('Admission unavailable'));
  mocks.listPeople.mockResolvedValue([
    person('admin', { admin: true }),
    { ...person('ivan', {}), blocked: null },
  ]);
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(automaticSwitch()).toBeNull();
  expect(container.textContent).toContain('people.admission.loadFailed');
  expect(container.textContent).not.toContain('people.loading');
  const ivan = Array.from(container.querySelectorAll('li')).find((li) =>
    li.textContent?.startsWith('ivan'),
  );
  // Whether Ivan was removed is unknown, so he is neither waiting nor blocked.
  expect(ivan?.textContent).toContain('people.status.noAccess');
  expect(ivan?.textContent).not.toContain('people.status.waiting');
  expect(ivan?.textContent).toContain('people.resetDevices');
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
