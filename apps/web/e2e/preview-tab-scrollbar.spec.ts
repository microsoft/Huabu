// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import type * as PreviewHeaderButtonModule from '../src/components/Nodes/PreviewHeaderButton';
import type * as HeaderModule from '../src/components/Panels/Header/CanvasHeader';
import type * as StripModule from '../src/components/Panels/PreviewWorkspace/PreviewTabStrip';
import type * as CanvasStoreModule from '../src/store/canvasStore';
import type { PreviewTab } from '../src/store/previewWorkspace/model';
import type * as PreviewModelModule from '../src/store/previewWorkspace/model';
import type * as ReactModule from 'react';
import type * as ReactDOMModule from 'react-dom/client';
import type * as RouterModule from 'react-router-dom';

test.use({ hasTouch: false });

test.beforeEach(async ({ page }) => {
  await page.goto('/setup');
  await page.evaluate(async () => {
    const dependencyUrl = (file: string) => {
      const resource = performance
        .getEntriesByType('resource')
        .find((entry) =>
          new URL(entry.name).pathname.endsWith(`/deps/${file}.js`),
        );
      if (!resource) throw new Error(`Vite has not loaded ${file}`);
      return resource.name;
    };
    const stripPath =
      '/src/components/Panels/PreviewWorkspace/PreviewTabStrip.tsx';
    const storePath = '/src/store/canvasStore.ts';
    const headerPath = '/src/components/Panels/Header/CanvasHeader.tsx';
    const modelPath = '/src/store/previewWorkspace/model.ts';
    const previewButtonPath = '/src/components/Nodes/PreviewHeaderButton.tsx';
    const [
      { default: React },
      { default: ReactDOM },
      { PreviewTabStrip },
      { default: canvasStore },
      { CanvasHeader },
      { MemoryRouter },
      { closeTabs },
      { PreviewHeaderButton },
    ] = await Promise.all([
      import(dependencyUrl('react')) as Promise<{
        default: typeof ReactModule;
      }>,
      import(dependencyUrl('react-dom_client')) as Promise<{
        default: typeof ReactDOMModule;
      }>,
      import(stripPath) as Promise<typeof StripModule>,
      import(storePath) as Promise<typeof CanvasStoreModule>,
      import(headerPath) as Promise<typeof HeaderModule>,
      import(dependencyUrl('react-router-dom')) as Promise<typeof RouterModule>,
      import(modelPath) as Promise<typeof PreviewModelModule>,
      import(previewButtonPath) as Promise<typeof PreviewHeaderButtonModule>,
    ]);
    const nodes = [
      {
        id: 'note',
        type: 'note',
        label: 'IPR 反馈与后续行动：核心问题和下一步计划',
      },
      { id: 'pdf', type: 'pdf', label: '项目研究资料与参考案例汇总' },
      { id: 'office', type: 'office', label: '团队协作方案与产品设计说明' },
      { id: 'text', type: 'text', label: '工作空间体验优化设计方案与讨论记录' },
    ];
    canvasStore.setState({
      nodes: nodes.map(({ id, type, label }) => ({
        id,
        type,
        position: { x: 0, y: 0 },
        data: { label, ...(type === 'office' ? { format: 'docx' } : {}) },
      })),
    });
    const host = document.createElement('div');
    host.dataset.testid = 'scrollbar-fixture';
    Object.assign(host.style, {
      position: 'fixed',
      top: '20px',
      left: '20px',
      width: '360px',
      zIndex: '100',
    });
    document.body.append(host);
    const noop = () => {};
    function Fixture() {
      const [tabs, setTabs] = React.useState<PreviewTab[]>([
        ...nodes.map(
          ({ id }, index): PreviewTab => ({
            id: `tab-${index}`,
            target: { kind: 'node', canvasId: 'scrollbar-test', nodeId: id },
            transient: index === 1,
            lastActiveSeq: index,
          }),
        ),
        {
          id: 'tab-4',
          target: {
            kind: 'url',
            canvasId: 'scrollbar-test',
            url: 'https://preview.example.com/reference?topic=research#summary',
          },
          transient: false,
          lastActiveSeq: 4,
        },
      ]);
      const [activeTabId, setActiveTabId] = React.useState('tab-0');
      return React.createElement(PreviewTabStrip, {
        groupId: 'scrollbar-test',
        tabs,
        activeTabId,
        onActivate: setActiveTabId,
        onClose: (id) => {
          setTabs((current) => current.filter((tab) => tab.id !== id));
          setActiveTabId('tab-0');
        },
        onCloseTabs: (id, scope) => {
          const groupId = 'scrollbar-test';
          const closed = closeTabs(
            {
              tabs: Object.fromEntries(tabs.map((tab) => [tab.id, tab])),
              groups: [
                { id: groupId, tabIds: tabs.map((tab) => tab.id), activeTabId },
              ],
              activeGroupId: groupId,
              splitRatio: 0.5,
              activationSeq: tabs.length,
            },
            id,
            scope,
          );
          setTabs(closed.groups[0].tabIds.map((tabId) => closed.tabs[tabId]));
          setActiveTabId(closed.groups[0].activeTabId ?? '');
        },
        onPromote: (id) =>
          setTabs((current) =>
            current.map((tab) =>
              tab.id === id ? { ...tab, transient: false } : tab,
            ),
          ),
        onNewChat: () => {
          const id = `new-${tabs.length}`;
          setTabs((current) => [
            ...current,
            {
              id,
              target: {
                kind: 'chat',
                canvasId: 'scrollbar-test',
                threadId: id,
              },
              transient: false,
              lastActiveSeq: current.length,
            },
          ]);
          setActiveTabId(id);
        },
        tabDropIndicator: null,
        isFullscreen: false,
        onToggleFullscreen: noop,
        onCollapse: noop,
      });
    }
    ReactDOM.createRoot(host).render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Fixture),
        React.createElement(
          'div',
          {
            'data-testid': 'preview-header-button-fixture',
            style: { position: 'fixed', top: 160, left: 20 },
          },
          React.createElement(
            PreviewHeaderButton,
            { title: 'Preview header action' },
            React.createElement('svg', { 'aria-hidden': true }),
          ),
        ),
        React.createElement(
          'div',
          {
            'data-testid': 'left-header-fixture',
            style: { position: 'fixed', top: 100, left: 20, width: 300 },
          },
          React.createElement(
            MemoryRouter,
            null,
            React.createElement(
              CanvasHeader,
              { compact: true, onToggle: noop },
              'IPR-R1-Follow-Up',
            ),
          ),
        ),
      ),
    );
  });
  await expect(
    page.getByTestId('scrollbar-fixture').getByRole('tab'),
  ).toHaveCount(5);
});

test('preview header actions keep compact geometry and muted color', async ({
  page,
}) => {
  const button = page
    .getByTestId('preview-header-button-fixture')
    .getByRole('button', {
      name: 'Preview header action',
    });
  await expect(button).toHaveCSS('width', '24px');
  await expect(button).toHaveCSS('height', '24px');
  await expect(button.locator('svg')).toHaveCSS('width', '13px');
  await expect(button.locator('svg')).toHaveCSS('height', '13px');
  expect(
    await button.evaluate((el) => {
      const probe = document.createElement('span');
      probe.className = 'text-fg-muted';
      el.append(probe);
      const matches =
        getComputedStyle(el).color === getComputedStyle(probe).color;
      probe.remove();
      return matches;
    }),
  ).toBe(true);
  await button.hover();
  const tooltip = page.getByRole('tooltip', { name: 'Preview header action' });
  await expect(tooltip).toBeVisible();
  const buttonBox = await button.boundingBox();
  const tooltipBox = await tooltip.boundingBox();
  if (!buttonBox || !tooltipBox)
    throw new Error('Preview action and tooltip must have layout boxes');
  expect(tooltipBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height);
});

test('context menu closes scoped batches and skips disabled actions', async ({
  page,
}) => {
  const host = page.getByTestId('scrollbar-fixture');
  const tabs = host.getByRole('tab');
  await tabs.nth(1).click({ button: 'right' });
  await page
    .getByRole('menuitem', { name: 'Close tabs to the right', exact: true })
    .click();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute('data-preview-tab-id', 'tab-1');
  await tabs.nth(1).click({ button: 'right' });
  await page
    .getByRole('menuitem', { name: 'Close other tabs', exact: true })
    .click();
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveAttribute('data-preview-tab-id', 'tab-1');
  await tabs.first().click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'Close other tabs', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('menuitem', {
      name: 'Close tabs to the right',
      exact: true,
    }),
  ).toBeDisabled();
  const close = page.getByRole('menuitem', { name: 'Close', exact: true });
  await close.focus();
  await page.keyboard.press('ArrowDown');
  const closeGroup = page.getByRole('menuitem', {
    name: 'Close all tabs in this group',
    exact: true,
  });
  await expect(closeGroup).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tabs).toHaveCount(0);
});

test('headers share a 44px band with a bottom rule only on Preview', async ({
  page,
}) => {
  const left = page.getByTestId('left-header-fixture').locator('header');
  const right = page.getByTestId('scrollbar-fixture').getByRole('tablist');
  const leftMetrics = await left.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const rule = getComputedStyle(element, '::after');
    const button = element.querySelector('button');
    if (!button) throw new Error('Header control missing');
    const control = button.getBoundingClientRect();
    return {
      height: rect.height,
      center: control.top + control.height / 2 - rect.top,
      ruleContent: rule.content,
      borderBottomWidth: getComputedStyle(element).borderBottomWidth,
    };
  });
  const rightMetrics = await right.evaluate((element) => {
    const header = element.parentElement;
    if (!header) throw new Error('Preview header missing');
    const rect = header.getBoundingClientRect();
    const rule = getComputedStyle(header, '::after');
    const button = header.querySelector('button');
    if (!button) throw new Error('Preview control missing');
    const control = button.getBoundingClientRect();
    return {
      height: rect.height,
      center: control.top + control.height / 2 - rect.top,
      ruleHeight: rule.height,
      ruleColor: rule.backgroundColor,
    };
  });
  expect(leftMetrics.height).toBe(rightMetrics.height);
  expect(leftMetrics.center).toBe(rightMetrics.center);
  expect(leftMetrics.height).toBe(44);
  expect(leftMetrics.center).toBe(22);
  expect(leftMetrics.ruleContent).toBe('none');
  expect(leftMetrics.borderBottomWidth).toBe('0px');
  expect(rightMetrics.ruleHeight).toBe('1px');
  await expect(right.getByRole('tab').first()).toHaveCSS(
    'border-radius',
    '8px',
  );
});

test('scrollbar appears only on hover or keyboard focus without moving centered pills', async ({
  page,
}) => {
  const host = page.getByTestId('scrollbar-fixture');
  const strip = host.getByRole('tablist');
  const metrics = () =>
    strip.evaluate((element) => {
      const tab = element.querySelector('[role="tab"]');
      const control = tab?.querySelector('button');
      const outer = element.parentElement;
      if (!tab || !control || !outer) {
        throw new Error('Preview tab strip is missing its tab or controls');
      }
      const rect = element.getBoundingClientRect();
      const controlRect = control.getBoundingClientRect();
      return {
        outerHeight: outer.getBoundingClientRect().height,
        gutter: element.offsetHeight - element.clientHeight,
        scrollbarHeight: getComputedStyle(element, '::-webkit-scrollbar')
          .height,
        scrollbarWidth: getComputedStyle(element).scrollbarWidth,
        overflows: element.scrollWidth > element.clientWidth,
        tabHeight: tab.getBoundingClientRect().height,
        viewportHeight: element.clientHeight,
        thumbColor: getComputedStyle(element, '::-webkit-scrollbar-thumb')
          .backgroundColor,
        tabCenter:
          tab.getBoundingClientRect().top +
          tab.getBoundingClientRect().height / 2 -
          rect.top,
        controlCenter: controlRect.top + controlRect.height / 2 - rect.top,
        scrollTop: element.scrollTop,
        controlsFit:
          controlRect.top >= rect.top &&
          controlRect.bottom <= rect.top + element.clientHeight,
      };
    });
  const narrow = await metrics();
  expect(narrow.outerHeight).toBe(44);
  expect(narrow.scrollbarHeight).toBe('4px');
  expect(narrow.scrollbarWidth).toBe('auto');
  expect(narrow.gutter).toBeLessThanOrEqual(4);
  expect(narrow.overflows).toBe(true);
  expect(narrow.tabHeight).toBe(28);
  expect(narrow.tabCenter).toBe(22);
  expect(narrow.controlCenter).toBe(22);
  expect(narrow.scrollTop).toBe(0);
  expect(narrow.thumbColor).toBe('rgba(0, 0, 0, 0)');
  expect(narrow.controlsFit).toBe(true);
  await strip.hover();
  const hovered = await metrics();
  expect(hovered.thumbColor).not.toBe(narrow.thumbColor);
  expect(hovered.tabCenter).toBe(narrow.tabCenter);
  expect(hovered.controlCenter).toBe(narrow.controlCenter);
  expect(hovered.gutter).toBe(narrow.gutter);
  await strip.getByRole('tab').first().click();
  await page.mouse.move(800, 500);
  await expect
    .poll(async () => (await metrics()).thumbColor)
    .toBe(narrow.thumbColor);
  await strip.evaluate((element) => {
    element.scrollLeft = 100;
  });
  expect(await strip.evaluate((element) => element.scrollLeft)).toBe(100);
  await host.evaluate((element) => {
    element.style.width = '1800px';
  });
  const wide = await metrics();
  expect(wide.overflows).toBe(false);
  expect(wide.gutter).toBe(0);
  expect(wide.outerHeight).toBe(44);
  expect(wide.tabHeight).toBe(28);
  expect(wide.tabCenter).toBe(22);
  expect(wide.controlCenter).toBe(22);
  expect(wide.controlsFit).toBe(true);
});

test('tabs shrink before overflowing and reserve readable titles and fixed controls', async ({
  page,
}) => {
  const host = page.getByTestId('scrollbar-fixture');
  const strip = host.getByRole('tablist');
  const sizes = () =>
    strip.getByRole('tab').evaluateAll((tabs) =>
      tabs.map((tab) => {
        const title = tab.querySelector<HTMLElement>(
          '[data-testid="preview-tab-title"]',
        );
        const actions = tab.querySelector<HTMLElement>(
          '[data-testid="preview-tab-actions"]',
        );
        if (!title || !actions)
          throw new Error('Tab title or actions are missing');
        return {
          width: tab.getBoundingClientRect().width,
          titleWidth: title.getBoundingClientRect().width,
          actionsWidth: actions.getBoundingClientRect().width,
          fontSize: parseFloat(getComputedStyle(title).fontSize),
          buttonWidths: Array.from(
            actions.querySelectorAll('button'),
            (button) => button.getBoundingClientRect().width,
          ),
        };
      }),
    );
  await host.evaluate((element) => {
    element.style.width = '1800px';
  });
  const wide = await sizes();
  await host.evaluate((element) => {
    element.style.width = '1000px';
  });
  const medium = await sizes();
  expect(medium[0].width).toBeGreaterThan(medium[2].width);
  expect(medium[2].width).toBeLessThan(wide[2].width);
  expect(
    await strip.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await host.evaluate((element) => {
    element.style.width = '360px';
  });
  const narrow = await sizes();
  expect(
    await strip.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  for (const [index, tab] of narrow.entries()) {
    expect(tab.titleWidth).toBeGreaterThanOrEqual(
      (index === 0 ? 6 : 4) * tab.fontSize - 1,
    );
    expect(tab.actionsWidth).toBe(wide[index].actionsWidth);
    expect(tab.buttonWidths.every((width) => width >= 24)).toBe(true);
  }
});

test('tooltips include full titles and types on hover and keyboard focus', async ({
  page,
}) => {
  const host = page.getByTestId('scrollbar-fixture');
  const tabs = host.getByRole('tab');
  await tabs.first().hover();
  await expect(page.getByRole('tooltip')).toContainText(
    'IPR 反馈与后续行动：核心问题和下一步计划',
  );
  await expect(page.getByRole('tooltip')).toContainText('Note');
  await page.mouse.move(800, 500);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await tabs.first().click();
  await page.mouse.move(800, 500);
  await tabs.first().press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  expect(
    await host
      .getByRole('tablist')
      .evaluate(
        (element) =>
          getComputedStyle(element, '::-webkit-scrollbar-thumb')
            .backgroundColor,
      ),
  ).not.toBe('rgba(0, 0, 0, 0)');
  await expect(page.getByRole('tooltip')).toContainText(
    '项目研究资料与参考案例汇总',
  );
  await expect(page.getByRole('tooltip')).toContainText('PDF');
  await expect(page.getByRole('tooltip')).toContainText('Temporary preview');
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip.getByTestId('preview-tooltip-title')).toHaveCSS(
    'font-size',
    '13px',
  );
  await expect(tooltip.getByTestId('preview-tooltip-title')).toHaveCSS(
    'font-weight',
    '600',
  );
  await expect(tooltip.getByTestId('preview-tooltip-meta')).toHaveCSS(
    'font-size',
    '11px',
  );
  await expect(tooltip.getByTestId('preview-tooltip-meta')).toHaveCSS(
    'opacity',
    '0.8',
  );
  await expect(tooltip.getByTestId('preview-tooltip-hint')).toHaveCSS(
    'font-size',
    '11px',
  );
  await expect(tooltip.getByTestId('preview-tooltip-hint')).toHaveCSS(
    'opacity',
    '0.7',
  );
  await tabs.nth(1).press('ArrowRight');
  await expect(page.getByRole('tooltip')).toContainText('Word');
  await tabs.nth(2).press('End');
  await expect(tabs.last()).toBeFocused();
  await expect(page.getByRole('tooltip')).toContainText(
    'https://preview.example.com/reference?topic=research#summary',
  );
  await expect(page.getByRole('tooltip')).toContainText('Website');
});

test('native scrolling, activation, resize, promotion and closing remain usable', async ({
  page,
}) => {
  const host = page.getByTestId('scrollbar-fixture');
  const strip = host.getByRole('tablist');
  const tabs = strip.getByRole('tab');
  await strip.hover();
  await page.mouse.wheel(150, 0);
  await expect
    .poll(() => strip.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await host.evaluate((element) => {
    element.style.width = '1000px';
  });
  await tabs.last().click();
  await host.evaluate((element) => {
    element.style.width = '360px';
  });
  const activeIsVisible = () =>
    strip.evaluate((element) => {
      const active = element.querySelector('[aria-selected="true"]');
      if (!active) throw new Error('No active tab');
      const tab = active.getBoundingClientRect();
      const viewport = element.getBoundingClientRect();
      return tab.left >= viewport.left - 1 && tab.right <= viewport.right + 1;
    });
  await expect.poll(activeIsVisible).toBe(true);
  await tabs.last().press('Home');
  await expect(tabs.first()).toBeFocused();
  await expect.poll(activeIsVisible).toBe(true);
  await tabs.first().press('ArrowRight');
  await tabs.nth(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Keep tab', exact: true }).click();
  await expect(tabs.nth(1)).not.toHaveClass(/italic/);
  await expect(tabs.nth(1).getByRole('button')).toHaveCount(1);
  await tabs
    .nth(1)
    .getByRole('button', { name: 'Close 项目研究资料与参考案例汇总' })
    .click();
  await expect(tabs).toHaveCount(4);
  await host
    .getByRole('button', { name: 'New conversation', exact: true })
    .click();
  await expect(tabs).toHaveCount(5);
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  await expect.poll(activeIsVisible).toBe(true);
});

test('active actions stay visible and inactive actions reveal without shifting titles', async ({
  page,
}) => {
  const host = page.getByTestId('scrollbar-fixture');
  await host.evaluate((element) => {
    element.style.width = '1000px';
  });
  const tabs = host.getByRole('tab');
  const activeActions = tabs.first().getByTestId('preview-tab-actions');
  const temporary = tabs.nth(1);
  const actions = temporary.getByTestId('preview-tab-actions');
  const title = temporary.getByTestId('preview-tab-title');
  await page.mouse.move(1200, 600);
  await expect(activeActions).toHaveCSS('opacity', '1');
  await expect(actions).toHaveCSS('opacity', '0');
  await expect(actions).toHaveCSS('pointer-events', 'none');
  const titleBefore = await title.boundingBox();
  const tabBefore = await temporary.boundingBox();
  expect(titleBefore).not.toBeNull();
  expect(tabBefore).not.toBeNull();
  if (!titleBefore || !tabBefore) throw new Error('Tab geometry missing');
  expect(
    tabBefore.x + tabBefore.width - titleBefore.x - titleBefore.width,
  ).toBe(8);
  await expect(title).toHaveCSS('mask-image', 'none');
  await temporary.hover();
  await expect(actions).toHaveCSS('opacity', '1');
  await expect(actions).toHaveCSS('pointer-events', 'auto');
  await expect(activeActions).toHaveCSS('opacity', '1');
  expect(await title.boundingBox()).toEqual(titleBefore);
  expect(await temporary.boundingBox()).toEqual(tabBefore);
  expect(
    await title.evaluate((element) => getComputedStyle(element).maskImage),
  ).not.toBe('none');
  await temporary.click();
  await page.mouse.move(1200, 600);
  await expect(actions).toHaveCSS('opacity', '1');
  await expect(activeActions).toHaveCSS('opacity', '0');
  await temporary.press('Home');
  await expect(tabs.first()).toBeFocused();
  await expect(activeActions).toHaveCSS('opacity', '1');
  await tabs.first().press('ArrowRight');
  await expect(temporary).toBeFocused();
  await expect(actions).toHaveCSS('opacity', '1');
  await temporary.press('Tab');
  const close = temporary.getByRole('button', { name: /^Close / });
  await expect(close).toBeFocused();
  await expect(actions).toHaveCSS('opacity', '1');
  await expect(temporary.getByRole('button')).toHaveCount(1);
  await temporary.focus();
  await temporary.press('Shift+F10');
  const pin = page.getByRole('menuitem', { name: 'Keep tab', exact: true });
  await expect(pin).toBeFocused();
  await pin.press('Enter');
  await expect(temporary).not.toHaveClass(/italic/);
});

test.describe('touch tab actions', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('keeps Close visible and supports double-tap promotion without hover', async ({
    page,
  }) => {
    const host = page.getByTestId('scrollbar-fixture');
    await host.evaluate((element) => {
      element.style.width = '1000px';
    });
    expect(
      await page.evaluate(() => matchMedia('(hover: hover)').matches),
    ).toBe(false);
    const tabs = host.getByRole('tab');
    const temporary = tabs.nth(1);
    const actions = temporary.getByTestId('preview-tab-actions');
    await expect(actions).toHaveCSS('opacity', '1');
    await expect(actions).toHaveCSS('pointer-events', 'auto');
    await expect(temporary.getByRole('button')).toHaveCount(1);
    const bounds = await temporary.boundingBox();
    if (!bounds) throw new Error('Temporary tab must be measurable');
    const x = bounds.x + 24;
    const y = bounds.y + bounds.height / 2;
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);
    await expect(temporary).not.toHaveClass(/italic/);
    await temporary.getByRole('button', { name: /^Close / }).tap();
    await expect(tabs).toHaveCount(4);
  });
});
