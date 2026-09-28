// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { NODE_TYPOGRAPHY } from '../src/components/Nodes/design/nodeTypography';

test('Note uses fixed insets and cards retain width-scaled spacing across orientations', async ({
  page,
}) => {
  await page.goto('/playground/design');
  await page.evaluate(async () => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const cardPath = '/src/components/Nodes/previewCard/PreviewCard.tsx';
    const notePath = '/src/components/Nodes/note/NoteContentViewport.tsx';
    const milkdownPath = '/src/components/Milkdown/MilkdownPreview.tsx';
    const { createElement: h } = (await import(reactPath)).default;
    const { createRoot } = (await import(domPath)).default;
    const { PreviewCard } = await import(cardPath);
    const { NoteContentViewport } = await import(notePath);
    const { MilkdownPreview } = await import(milkdownPath);
    const host = document.createElement('div');
    host.id = 'spacing-fixture';
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto';
    document.body.append(host);
    const image =
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>';
    createRoot(host).render(
      h(
        'div',
        null,
        ...[400, 600].flatMap((width) => {
          const shell = {
            width,
            border: '3px solid transparent',
            boxSizing: 'border-box',
          };
          return [
            h(
              'div',
              {
                key: `note-${width}`,
                'data-spacing': `note-${width}`,
                style: { ...shell, height: 400 },
              },
              h(
                NoteContentViewport,
                {
                  scrollingEnabled: false,
                  viewportRef: null,
                  contentHostRef: null,
                  onScroll: () => {},
                },
                h(MilkdownPreview, { markdown: '# Title\n\nBody' }),
              ),
            ),
            ...['web', 'pdf'].flatMap((type) =>
              ['horizontal', 'vertical', 'text'].map((orientation) => {
                const height = orientation === 'horizontal' ? 214 : width;
                return h(
                  'div',
                  {
                    key: `${type}-${width}-${orientation}`,
                    'data-spacing': `${type}-${width}-${orientation}`,
                    style: { ...shell, height },
                  },
                  h(PreviewCard, {
                    width,
                    height,
                    nodeType: type,
                    source: type === 'pdf' ? 'PDF' : 'example.com',
                    title: 'Title',
                    summary: 'Description',
                    image: orientation === 'text' ? undefined : image,
                  }),
                );
              }),
            ),
          ];
        }),
      ),
    );
  });
  const fixture = page.locator('#spacing-fixture');
  await expect(fixture.locator('.ProseMirror h1')).toHaveCount(2);
  for (const width of [400, 600]) {
    const expectedPadding = (16 * (width - 6)) / 400;
    const noteInset = await fixture
      .locator(`[data-spacing="note-${width}"]`)
      .evaluate((el) => {
        const host = el.querySelector<HTMLElement>('[data-note-content-host]');
        if (!host) throw new Error('Missing Note host');
        const frame = host.closest('.huabu-note-scroll-frame');
        if (!frame) throw new Error('Missing scale frame');
        const scale = new DOMMatrixReadOnly(getComputedStyle(frame).transform)
          .a;
        const style = getComputedStyle(host);
        return [
          style.paddingTop,
          style.paddingRight,
          style.paddingBottom,
          style.paddingLeft,
        ].map((value) => parseFloat(value) * scale);
      });
    for (const inset of noteInset) expect(inset).toBeCloseTo(16, 2);
    await expect(
      fixture.locator(`[data-spacing="note-${width}"] .ProseMirror h1`),
    ).toHaveCSS('font-size', '28px');
    await expect(
      fixture.locator(`[data-spacing="note-${width}"] .ProseMirror p`).first(),
    ).toHaveCSS('font-size', '18px');
    for (const type of ['web', 'pdf']) {
      for (const orientation of ['horizontal', 'vertical', 'text']) {
        const card = fixture.locator(
          `[data-spacing="${type}-${width}-${orientation}"] .preview-card`,
        );
        await expect(card).toHaveAttribute('data-orientation', orientation);
        await expect(card.locator('.preview-card__title')).toHaveCSS(
          'font-size',
          '28px',
        );
        await expect(card.locator('.preview-card__summary')).toHaveCSS(
          'font-size',
          '18px',
        );
        const metrics = await card.evaluate((el, horizontal) => {
          const surface = horizontal
            ? el
            : el.querySelector('.preview-card__info');
          if (!surface) throw new Error('Missing info');
          const style = getComputedStyle(surface);
          const summary = el.querySelector('.preview-card__summary');
          return {
            insets: [
              style.paddingTop,
              style.paddingRight,
              style.paddingBottom,
              style.paddingLeft,
            ].map(parseFloat),
            gap: parseFloat(getComputedStyle(el).columnGap),
            summaryGap: summary
              ? parseFloat(getComputedStyle(summary).marginTop)
              : 0,
          };
        }, orientation === 'horizontal');
        for (const inset of metrics.insets)
          expect(inset).toBeCloseTo(expectedPadding, 2);
        if (orientation === 'horizontal')
          expect(metrics.gap).toBeCloseTo((12 * (width - 6)) / 400, 2);
        expect(metrics.summaryGap).toBeCloseTo((8 * (width - 6)) / 400, 2);
      }
    }
  }
});

test('canvas Notes and measurement share typography without affecting expanded preview or generic Milkdown', async ({
  page,
}) => {
  await page.goto('/playground/design');
  await page.evaluate(async () => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const previewPath = '/src/components/Nodes/note/NotePreview.tsx';
    const milkdownPath = '/src/components/Milkdown/MilkdownPreview.tsx';
    const hostPath = '/src/components/Nodes/note/noteContentHost.ts';
    const { createElement: h } = (await import(reactPath)).default;
    const { createRoot } = (await import(domPath)).default;
    const { NotePreview } = await import(previewPath);
    const { MilkdownPreview } = await import(milkdownPath);
    const { NOTE_CONTENT_HOST_CLASS, NOTE_CONTENT_HOST_STYLE } = await import(
      hostPath
    );
    const markdown =
      '# Heading one\n\n## Heading two\n\n### Heading three\n\n#### Heading four\n\n##### Heading five\n\n###### Heading six\n\nBody paragraph\n\n- List item';
    const container = document.createElement('div');
    container.id = 'note-heading-fixture';
    container.style.cssText =
      'position:fixed;inset:0;z-index:99999;overflow:auto';
    document.body.append(container);
    createRoot(container).render(
      h(
        'div',
        null,
        ...['canvas', 'measurer'].map((id) =>
          h(
            'div',
            {
              key: id,
              'data-heading-surface': id,
              className: NOTE_CONTENT_HOST_CLASS,
              style: {
                ...NOTE_CONTENT_HOST_STYLE,
                width: '400px',
                ...(id === 'measurer' ? { visibility: 'hidden' } : {}),
              },
            },
            h(MilkdownPreview, { markdown }),
          ),
        ),
        h(
          'div',
          { 'data-heading-surface': 'expanded' },
          h(NotePreview, { data: { content: markdown } }),
        ),
        h(
          'div',
          { 'data-heading-surface': 'generic' },
          h(MilkdownPreview, { markdown }),
        ),
      ),
    );
  });
  const fixture = page.locator('#note-heading-fixture');
  for (const surface of ['canvas', 'measurer']) {
    const prose = fixture.locator(
      `[data-heading-surface="${surface}"] .ProseMirror`,
    );
    await expect(prose.locator('h6')).toBeAttached();
    for (const [index, size] of [28, 24, 20, 16, 16, 16].entries()) {
      await expect(prose.locator(`h${index + 1}`)).toHaveCSS(
        'font-size',
        `${size}px`,
      );
      await expect(prose.locator(`h${index + 1}`)).toHaveCSS(
        'font-weight',
        index === 0 ? '600' : '500',
      );
    }
    await expect(prose.locator('p').first()).toHaveCSS(
      'font-size',
      `${NODE_TYPOGRAPHY.body.size}px`,
    );
    await expect(prose.locator('li').first()).toHaveCSS(
      'font-size',
      `${NODE_TYPOGRAPHY.body.size}px`,
    );
  }
  for (const surface of ['expanded', 'generic']) {
    const prose = fixture.locator(
      `[data-heading-surface="${surface}"] .ProseMirror`,
    );
    await expect(prose.locator('h6')).toBeAttached();
    for (const [index, size] of [27.44, 22, 19.2, 17.36, 16, 14.64].entries()) {
      await expect(prose.locator(`h${index + 1}`)).toHaveCSS(
        'font-size',
        `${size}px`,
      );
      await expect(prose.locator(`h${index + 1}`)).toHaveCSS(
        'font-weight',
        '600',
      );
    }
    for (const selector of ['p', 'li']) {
      await expect(prose.locator(selector).first()).toHaveCSS(
        'font-size',
        '14px',
      );
      await expect(prose.locator(selector).first()).toHaveCSS(
        'line-height',
        '21px',
      );
    }
  }
});

for (const nodeType of ['web', 'pdf']) {
  test(`horizontal ${nodeType} titles use available height before descriptions`, async ({
    page,
  }) => {
    await page.goto('/playground/design');
    await page.evaluate(async (type) => {
      // Load the production component through the isolated Vite test server.
      const reactPath = '/node_modules/.vite/deps/react.js';
      const domPath = '/node_modules/.vite/deps/react-dom_client.js';
      const cardPath = '/src/components/Nodes/previewCard/PreviewCard.tsx';
      const { createElement } = (await import(reactPath)).default;
      const { createRoot } = (await import(domPath)).default;
      const { PreviewCard } = await import(cardPath);
      const host = document.createElement('div');
      host.id = 'title-priority-fixture';
      host.style.cssText =
        'position:fixed;inset:0 auto auto 0;z-index:99999;width:400px;height:260px';
      document.body.append(host);
      const root = createRoot(host);
      const render = (
        title: string,
        height: number,
        summary: string | undefined,
        image: string | undefined,
      ) => {
        host.style.height = `${height}px`;
        root.render(
          createElement(PreviewCard, {
            width: 400,
            height,
            nodeType: type,
            source: type === 'pdf' ? 'PDF' : 'example.com',
            title,
            summary,
            image,
          }),
        );
      };
      host.addEventListener('fixture-update', (event) => {
        const { title, height, summary, image } = (event as CustomEvent).detail;
        render(title, height, summary, image);
      });
    }, nodeType);
    const host = page.locator('#title-priority-fixture');
    const card = host.locator('.preview-card');
    const title = host.locator('.preview-card__title');
    const summary = host.locator('.preview-card__summary');
    const image =
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>';
    const update = async (
      text: string,
      height: number,
      description: string | undefined = 'Secondary description',
      cover: string | undefined = image,
    ) => {
      await host.evaluate(
        (element, detail) =>
          element.dispatchEvent(new CustomEvent('fixture-update', { detail })),
        { title: text, height, summary: description, image: cover },
      );
    };
    const threeLines = '研究材料标题'.repeat(4);
    await update(threeLines, 260);
    await expect(card).toHaveAttribute('data-orientation', 'horizontal');
    await expect
      .poll(() =>
        title.evaluate(
          (el) => el.clientHeight / parseFloat(getComputedStyle(el).lineHeight),
        ),
      )
      .toBeGreaterThan(2.8);
    await expect(summary).toBeVisible();
    await update(threeLines.repeat(10), 260);
    await expect(summary).toBeHidden();
    const largeBudget = await title.evaluate((el) =>
      Number(getComputedStyle(el).webkitLineClamp),
    );
    expect(largeBudget).toBeGreaterThan(2);
    await update(threeLines.repeat(10), 170);
    await expect
      .poll(() =>
        title.evaluate((el) => Number(getComputedStyle(el).webkitLineClamp)),
      )
      .toBeLessThan(largeBudget);
    await expect(summary).toBeHidden();
    await update(threeLines, 260);
    await expect(summary).toBeVisible();
    await update(threeLines, 260, '');
    await expect(summary).toHaveCount(0);
    await expect
      .poll(() =>
        title.evaluate(
          (el) => el.clientHeight / parseFloat(getComputedStyle(el).lineHeight),
        ),
      )
      .toBeGreaterThan(2.8);
    await update(threeLines.repeat(10), 400);
    await expect(card).toHaveAttribute('data-orientation', 'vertical');
    await expect(title).toHaveCSS('-webkit-line-clamp', '2');
    await expect(summary).toBeHidden();
  });
}

test('same-width nodes use distinct heading roles and shared body sizes', async ({
  page,
}) => {
  await page.goto('/playground/design#zoomed-overview');
  const scene = page.locator('[data-study-scene="independent"]').first();
  await expect(scene.locator('.ProseMirror h1')).toBeVisible();
  const metrics = await scene
    .locator('[data-study-node]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const title = node.querySelector(
          '.ProseMirror h1, .preview-card__title',
        );
        const body = node.querySelector(
          '.ProseMirror p, .preview-card__summary',
        );
        if (!title || !body) throw new Error('Missing typography specimen');
        const frame = node.querySelector('.huabu-note-scroll-frame');
        const scale = frame
          ? new DOMMatrixReadOnly(getComputedStyle(frame).transform).a
          : 1;
        return {
          titleBase: parseFloat(getComputedStyle(title).fontSize),
          title: parseFloat(getComputedStyle(title).fontSize) * scale,
          body: parseFloat(getComputedStyle(body).fontSize) * scale,
          weight: getComputedStyle(title).fontWeight,
        };
      }),
    );
  expect(metrics).toHaveLength(3);
  expect(metrics[0].titleBase).toBe(28);
  const h2 = scene.locator('.ProseMirror h2').first();
  await expect(h2).toHaveCSS('font-size', '24px');
  for (const [index, metric] of metrics.entries()) {
    expect(metric.title).toBeCloseTo(
      index === 0 ? NODE_TYPOGRAPHY.title.size : NODE_TYPOGRAPHY.cardTitle.size,
      2,
    );
    expect(metric.body).toBeCloseTo(NODE_TYPOGRAPHY.body.size, 2);
    expect(metric.weight).toBe(index === 0 ? '600' : '500');
  }
});

test('Web and PDF descriptions disappear for clipped titles and return when titles fit', async ({
  page,
}) => {
  await page.goto('/playground/design#zoomed-overview');
  const scene = page.locator('[data-study-scene="independent"]').first();
  for (const type of ['web', 'pdf']) {
    const card = scene.locator(`[data-study-node="${type}"] .preview-card`);
    const summary = card.locator('.preview-card__summary');
    await expect(card).toBeVisible();
    await card.evaluate((element) => {
      const heading = element.querySelector('.preview-card__title');
      if (!heading) throw new Error('Missing heading');
      heading.textContent =
        'A long material title that cannot fit in two lines. '.repeat(12);
      (element as HTMLElement).style.width = '390px';
    });
    await expect(summary).toBeHidden();
    await card.evaluate((element) => {
      const heading = element.querySelector('.preview-card__title');
      if (!heading) throw new Error('Missing heading');
      heading.textContent = 'Short title';
      (element as HTMLElement).style.width = '394px';
    });
    await expect(summary).toBeVisible();
  }
});
