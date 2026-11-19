// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AGENT_ICON_BRANDS } from '@huabu/shared';

import { AgentIcon } from './AgentIcon';

describe('AgentIcon', () => {
  it('draws the shape and face when no logo is set', () => {
    const markup = renderToStaticMarkup(
      <AgentIcon shape="diamond" color="red" size={20} />,
    );
    expect(markup).toContain('<polygon');
    expect(markup).not.toContain('data-agent-brand');
  });

  it.each(AGENT_ICON_BRANDS)(
    'draws the %s logo in place of the shape',
    (brand) => {
      const markup = renderToStaticMarkup(
        <AgentIcon shape="diamond" color="red" brand={brand} size={20} />,
      );
      expect(markup).toContain(`data-agent-brand="${brand}"`);
      expect(markup).toContain('data:image/svg+xml');
      expect(markup).not.toContain('<polygon');
    },
  );

  it('paints a single-color logo in the theme foreground', () => {
    const mono = renderToStaticMarkup(
      <AgentIcon shape="diamond" color="red" brand="codex" />,
    );
    expect(mono).toContain('text-fg-default');
    expect(mono).toContain('mask:');
    const color = renderToStaticMarkup(
      <AgentIcon shape="diamond" color="red" brand="claude" />,
    );
    expect(color).not.toContain('mask:');
  });

  it('pulses a working logo instead of rotating it', () => {
    const markup = renderToStaticMarkup(
      <AgentIcon shape="diamond" color="red" brand="claude" motion="working" />,
    );
    expect(markup).toContain('agent-icon-working-brand');
    expect(markup).not.toContain('agent-icon-working-body');
  });
});
