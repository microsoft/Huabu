// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Panel, useReactFlow, useStore } from '@xyflow/react';
import { ChevronDown } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import { MENU_SEPARATOR_CLASS } from '@/components/Common/menuStyles';
import { TextInput } from '@/components/Common/TextInput';
import { MAX_ZOOM, MIN_ZOOM } from '@/config/canvas';
import { formatShortcutById } from '@/config/shortcuts';

import { fitCanvasContent } from '../CanvasLayerPanel/focusNodesOnCanvas';

export function CanvasZoomMenu() {
  const { t } = useTranslation();
  const instance = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const hasNodes = useStore((state) =>
    state.nodes.some((node) => !node.hidden),
  );
  const hasSelection = useStore((state) =>
    state.nodes.some((node) => node.selected && !node.hidden),
  );
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const percentage = Math.round(zoom * 100);

  const changeOpen = (next: boolean) => {
    if (next) {
      setDraft(String(Math.round(instance.getZoom() * 100)));
      setInvalid(false);
    } else {
      triggerRef.current?.focus();
    }
    setOpen(next);
  };

  const run = (action: () => void) => {
    action();
    changeOpen(false);
  };

  const submitZoom = () => {
    const value = Number(draft.trim().replace(/%$/, '').trim());
    if (
      !Number.isFinite(value) ||
      value < MIN_ZOOM * 100 ||
      value > MAX_ZOOM * 100
    ) {
      setInvalid(true);
      inputRef.current?.focus();
      return;
    }
    run(() => void instance.zoomTo(value / 100));
  };

  return (
    <Panel
      position="bottom-left"
      className="react-flow__controls bg-surface mx-4! my-6!"
    >
      <DropdownMenu
        floating
        placement="top-start"
        align="top-left"
        open={open}
        onOpenChange={changeOpen}
        onOpenAutoFocus={() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
        className="min-w-52"
        trigger={
          <Button
            ref={triggerRef}
            variant="ghost"
            size="sm"
            className="focus-visible:ring-info-light h-8 w-17.5 touch-manipulation justify-center gap-1 px-2 tabular-nums focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
            aria-label={t('canvasControls.zoomAria', { percentage })}
            aria-haspopup="dialog"
            aria-controls={open ? id : undefined}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                event.stopPropagation();
                changeOpen(true);
              }
            }}
          >
            <span className="shrink-0 whitespace-nowrap">{percentage}%</span>
            <ChevronDown aria-hidden="true" />
          </Button>
        }
      >
        <div
          role="presentation"
          onKeyDown={(event) => {
            event.stopPropagation();
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'input, button:not(:disabled)',
              ),
            );
            const index = controls.findIndex(
              (control) => control === document.activeElement,
            );
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const direction = event.key === 'ArrowDown' ? 1 : -1;
              controls[
                (index + direction + controls.length) % controls.length
              ]?.focus();
            } else if (
              event.key === 'Tab' &&
              ((event.shiftKey && index === 0) ||
                (!event.shiftKey && index === controls.length - 1))
            ) {
              event.preventDefault();
              changeOpen(false);
            }
          }}
        >
          <div id={id} role="dialog" aria-label={t('canvasControls.zoomMenu')}>
            <form
              className="px-2 py-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                submitZoom();
              }}
            >
              <label
                htmlFor={`${id}-input`}
                className="text-fg-subtle mb-1.5 block text-xs"
              >
                {t('canvasControls.zoomLevel')}
              </label>
              <div className="relative">
                <TextInput
                  ref={inputRef}
                  id={`${id}-input`}
                  name="canvasZoom"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setInvalid(false);
                  }}
                  aria-invalid={invalid}
                  aria-describedby={invalid ? `${id}-error` : undefined}
                  className="w-full pr-7 tabular-nums"
                />
                <span
                  aria-hidden="true"
                  className="text-fg-subtle pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs"
                >
                  %
                </span>
              </div>
              {invalid && (
                <p
                  id={`${id}-error`}
                  role="alert"
                  className="text-danger mt-1 text-xs"
                >
                  {t('canvasControls.invalidZoom', {
                    min: MIN_ZOOM * 100,
                    max: MAX_ZOOM * 100,
                  })}
                </p>
              )}
            </form>
            <div role="menu" aria-label={t('canvasControls.zoomMenu')}>
              <div role="separator" className={MENU_SEPARATOR_CLASS} />
              <DropdownMenuItem
                shortcut={formatShortcutById('view.zoomIn')}
                disabled={zoom >= MAX_ZOOM}
                onClick={() => run(() => void instance.zoomIn())}
              >
                {t('canvasControls.zoomIn')}
              </DropdownMenuItem>
              <DropdownMenuItem
                shortcut={formatShortcutById('view.zoomOut')}
                disabled={zoom <= MIN_ZOOM}
                onClick={() => run(() => void instance.zoomOut())}
              >
                {t('canvasControls.zoomOut')}
              </DropdownMenuItem>
              <DropdownMenuItem
                shortcut={formatShortcutById('view.resetZoom')}
                onClick={() => run(() => void instance.zoomTo(1))}
              >
                {t('canvasControls.resetZoom')}
              </DropdownMenuItem>
              <div role="separator" className={MENU_SEPARATOR_CLASS} />
              <DropdownMenuItem
                shortcut={formatShortcutById('view.fitAll')}
                disabled={!hasNodes}
                onClick={() =>
                  run(() => void fitCanvasContent(instance, 'all'))
                }
              >
                {t('canvasControls.fitAll')}
              </DropdownMenuItem>
              <DropdownMenuItem
                shortcut={formatShortcutById('view.fitSelection')}
                disabled={!hasSelection}
                onClick={() =>
                  run(() => void fitCanvasContent(instance, 'selection'))
                }
              >
                {t('canvasControls.fitSelection')}
              </DropdownMenuItem>
            </div>
          </div>
        </div>
      </DropdownMenu>
    </Panel>
  );
}
