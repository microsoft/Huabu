// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSubmenu,
} from '@/components/Common/DropdownMenu';
import { TextInput } from '@/components/Common/TextInput';
import { TextFontSizePicker } from '@/components/Panels/Canvas/FloatingToolbars/TextFontSizePicker';
import { LayerFilterBar } from '@/components/Panels/CanvasLayerPanel/LayerFilterBar';

import '@/components/Panels/Canvas/FloatingToolbars/NodeToolbar.css';

import type { LayerFilterKey } from '@/components/Panels/CanvasLayerPanel/layerFilterKey';

function DropdownMenuFixture() {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(16);
  const [filters, setFilters] = useState(new Set<LayerFilterKey>(['pdf']));
  const [dialog, setDialog] = useState(false);

  return (
    <div className="flex flex-col items-start gap-3 p-4">
      {['coordinate', 'anchored'].map((mode) => (
        <DropdownMenu
          key={mode}
          floating={mode === 'anchored'}
          open={openMenu === mode}
          onOpenChange={(open) => setOpenMenu(open ? mode : null)}
          trigger={<Button>{mode} actions</Button>}
        >
          <DropdownMenuSubmenu label="More actions">
            <DropdownMenuItem disabled>Unavailable action</DropdownMenuItem>
            <DropdownMenuItem>Nested action</DropdownMenuItem>
          </DropdownMenuSubmenu>
          {Array.from({ length: 40 }, (_, index) => (
            <DropdownMenuItem key={index} onClick={() => setOpenMenu(null)}>
              Item {index + 1}
            </DropdownMenuItem>
          ))}
        </DropdownMenu>
      ))}
      <div className="node-floating-toolbar flex w-fit">
        <TextFontSizePicker value={fontSize} onApply={setFontSize} />
      </div>
      <div className="w-25" data-filter-sample>
        <LayerFilterBar
          availableKeys={['note', 'text', 'image', 'pdf', 'question']}
          selectedKeys={filters}
          onToggleKey={(key) =>
            setFilters((current) => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          hasAnyFrame={false}
          hasAnyExpandedFrame={false}
          onToggleAllFrames={() => undefined}
          isSearchActive={false}
        />
      </div>
      <DropdownMenu
        open={openMenu === 'dialog'}
        onOpenChange={(open) => setOpenMenu(open ? 'dialog' : null)}
        trigger={<Button>Dialog actions</Button>}
      >
        <DropdownMenuItem
          onClick={() => {
            setOpenMenu(null);
            setDialog(true);
          }}
        >
          Edit name
        </DropdownMenuItem>
      </DropdownMenu>
      {dialog && (
        <div role="dialog" aria-label="Edit name">
          <TextInput autoFocus aria-label="Name" />
        </div>
      )}
      <Button className="fixed right-4 bottom-4">After menus</Button>
    </div>
  );
}

export function mountDropdownMenuFixture() {
  document.getElementById('root')?.setAttribute('hidden', '');
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;inset:0;background:var(--bg-default);z-index:10;overflow:auto';
  document.body.append(host);
  createRoot(host).render(<DropdownMenuFixture />);
}
