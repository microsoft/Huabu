// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button } from '@/components/Common/Button';
import { Popover } from '@/components/Common/Popover';
import { Select } from '@/components/Common/Select';

import { SettingLabel } from './SettingLabel';
import { SettingRow } from './SettingRow';
import { SettingSection } from './SettingSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function DraftContent({
  onMount,
  onUnmount,
}: {
  onMount: () => void;
  onUnmount: () => void;
}) {
  const [draft, setDraft] = useState('original');
  useEffect(() => {
    onMount();
    return onUnmount;
  }, [onMount, onUnmount]);
  return (
    <>
      <span data-testid="draft">{draft}</span>
      <Button onClick={() => setDraft('draft')}>Edit draft</Button>
    </>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SettingSection', () => {
  it('keeps descriptions and optional markers readable without enlarging them', () => {
    act(() =>
      root.render(
        <SettingSection>
          <SettingRow
            title={<SettingLabel optional>Profile</SettingLabel>}
            description="Used for auxiliary tasks."
          >
            <Button>Configure</Button>
          </SettingRow>
        </SettingSection>,
      ),
    );
    const description = container.querySelector('.setting-row p.text-xs');
    expect(description?.classList.contains('text-fg-muted')).toBe(true);
    expect(description?.classList.contains('text-sm')).toBe(false);
    const optional = container.querySelector('.setting-row span.font-normal');
    expect(optional?.classList.contains('text-fg-muted')).toBe(true);
    expect(optional?.textContent).toContain('settings.optional');
  });

  it('dismisses its portaled Select without a pointer press, preserving drafts and unrelated popovers', async () => {
    const onMount = vi.fn();
    const onUnmount = vi.fn();
    const onChange = vi.fn();
    const unrelatedDismiss = vi.fn();
    await act(async () =>
      root.render(
        <>
          <SettingSection title="Draft section" collapsible keepMounted>
            <DraftContent onMount={onMount} onUnmount={onUnmount} />
            <Select
              ariaLabel="Draft choice"
              value="first"
              options={[{ value: 'first', label: 'First choice' }]}
              onChange={onChange}
            />
          </SettingSection>
          <Popover onDismiss={unrelatedDismiss}>
            <span data-testid="unrelated-panel">Unrelated panel</span>
          </Popover>
        </>,
      ),
    );
    const heading = container.querySelector<HTMLButtonElement>(
      'button[aria-controls]',
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Draft choice"]',
    );
    const edit = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Edit draft',
    );
    if (!heading || !trigger || !edit) throw new Error('Missing controls');
    await act(async () => {
      edit.click();
      trigger.click();
    });
    expect(document.querySelector('[role="option"]')).not.toBeNull();
    expect(container.querySelector('[role="option"]')).toBeNull();
    await act(async () => {
      heading.focus();
      heading.click();
    });
    expect(heading.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(heading);
    expect(document.querySelector('[role="option"]')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(unrelatedDismiss).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="unrelated-panel"]'),
    ).not.toBeNull();
    expect(onMount).toHaveBeenCalledOnce();
    expect(onUnmount).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => heading.click());
    expect(document.querySelector('[role="option"]')).toBeNull();
    expect(container.querySelector('[data-testid="draft"]')?.textContent).toBe(
      'draft',
    );
    await act(async () => trigger.click());
    expect(document.querySelector('[role="option"]')).not.toBeNull();
  });

  it('lazily mounts preserved content and retains drafts through collapse and expansion', () => {
    const onMount = vi.fn();
    const onUnmount = vi.fn();
    const onCollapsedChange = vi.fn();
    act(() =>
      root.render(
        <SettingSection
          title="Draft section"
          collapsible
          defaultCollapsed
          keepMounted
          onCollapsedChange={onCollapsedChange}
        >
          <DraftContent onMount={onMount} onUnmount={onUnmount} />
        </SettingSection>,
      ),
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-expanded]',
    );
    if (!toggle) throw new Error('Missing section heading');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(onMount).not.toHaveBeenCalled();
    act(() => toggle.click());
    const card = container.querySelector<HTMLElement>('.divide-y');
    const draft = container.querySelector('[data-testid="draft"]');
    const edit = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Edit draft',
    );
    if (!card || !edit) throw new Error('Missing draft editor');
    expect(toggle.getAttribute('aria-controls')).toBe(card.id);
    act(() => edit.click());
    expect(draft?.textContent).toBe('draft');
    act(() => toggle.click());
    expect(card.hidden).toBe(true);
    expect(draft?.closest('[hidden]')).toBe(card);
    expect(onMount).toHaveBeenCalledOnce();
    expect(onUnmount).not.toHaveBeenCalled();
    act(() => toggle.click());
    expect(container.querySelector('.divide-y')).toBe(card);
    expect(card.hidden).toBe(false);
    expect(container.querySelector('[data-testid="draft"]')).toBe(draft);
    expect(draft?.textContent).toBe('draft');
    expect(onCollapsedChange.mock.calls).toEqual([[false], [true], [false]]);
  });

  it('retains the default unmount-on-collapse behavior for other callers', () => {
    const onMount = vi.fn();
    const onUnmount = vi.fn();
    act(() =>
      root.render(
        <SettingSection title="Draft section" collapsible>
          <DraftContent onMount={onMount} onUnmount={onUnmount} />
        </SettingSection>,
      ),
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-expanded]',
    );
    if (!toggle) throw new Error('Missing section heading');
    expect(onMount).toHaveBeenCalledOnce();
    act(() => toggle.click());
    expect(container.querySelector('[data-testid="draft"]')).toBeNull();
    expect(onUnmount).toHaveBeenCalledOnce();
    act(() => toggle.click());
    expect(onMount).toHaveBeenCalledTimes(2);
  });

  it.each([
    { collapsible: false, withAction: false },
    { collapsible: true, withAction: false },
    { collapsible: false, withAction: true },
    { collapsible: true, withAction: true },
  ])(
    'uses a 6px heading gap and 16px section spacing while preserving card layout: %o',
    ({ collapsible, withAction }) => {
      act(() => {
        root.render(
          <SettingSection
            title="Devices"
            collapsible={collapsible}
            action={
              withAction ? <Button size="sm">Add device</Button> : undefined
            }
          >
            <span>Device row</span>
          </SettingSection>,
        );
      });
      const heading = container.querySelector(
        collapsible ? '[aria-expanded]' : 'h4',
      );
      const spacingElement =
        collapsible || withAction ? heading?.parentElement : heading;
      const card = container.querySelector('.divide-y');
      expect(spacingElement?.classList.contains('mb-1.5')).toBe(true);
      expect(
        container.querySelector('section')?.classList.contains('mb-4'),
      ).toBe(true);
      expect(card?.classList.contains('border')).toBe(true);
      expect(card?.textContent).toBe('Device row');
      expect(card?.contains(heading)).toBe(false);
    },
  );

  it('keeps the header action independent and available when collapsed', () => {
    const onAction = vi.fn();
    const onCollapsedChange = vi.fn();
    act(() => {
      root.render(
        <SettingSection
          title="Devices"
          collapsible
          defaultCollapsed
          onCollapsedChange={onCollapsedChange}
          action={
            <Button variant="ghost" size="sm" onClick={onAction}>
              Add device
            </Button>
          }
        >
          <span>Device row</span>
        </SettingSection>,
      );
    });
    const toggle =
      container.querySelector<HTMLButtonElement>('[aria-expanded]');
    const action =
      container.querySelector<HTMLButtonElement>('.ml-auto button');
    expect(toggle?.contains(action)).toBe(false);
    expect(container.querySelector('.divide-y')).toBeNull();
    act(() => action?.click());
    expect(onAction).toHaveBeenCalledOnce();
    expect(onCollapsedChange).not.toHaveBeenCalled();
    act(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.divide-y')?.textContent).toBe(
      'Device row',
    );
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it('uses compact collapsed spacing and a leading disclosure icon in a full-row target', () => {
    act(() =>
      root.render(
        <SettingSection title="Advanced settings" collapsible defaultCollapsed>
          <span>Settings content</span>
        </SettingSection>,
      ),
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-expanded]',
    );
    if (!toggle) throw new Error('Missing section heading');
    const section = toggle.closest('section');
    expect(section?.classList.contains('mb-2')).toBe(true);
    expect(toggle.parentElement?.classList.contains('mb-1.5')).toBe(false);
    expect(toggle.classList.contains('flex-1')).toBe(true);
    expect(toggle.classList.contains('min-h-8')).toBe(true);
    expect(toggle.classList.contains('enabled:hover:bg-hover')).toBe(true);
    expect(toggle.classList.contains('focus-visible:outline-2')).toBe(true);
    expect(toggle.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(toggle.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(toggle.firstElementChild?.classList.contains('-rotate-90')).toBe(
      true,
    );
    act(() => toggle.click());
    expect(section?.classList.contains('mb-4')).toBe(true);
    expect(toggle.parentElement?.classList.contains('mb-1.5')).toBe(true);
    expect(toggle.firstElementChild?.classList.contains('-rotate-90')).toBe(
      false,
    );
  });
});
