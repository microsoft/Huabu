// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { Popover } from '@/components/Common/Popover';
import { TextInput } from '@/components/Common/TextInput';
import { copyToClipboard } from '@/utils/io/clipboard';
import { normalizeSafeLinkHref } from '@/utils/safeLink';

import type { MilkdownInstance, MilkdownLinkSnapshot } from './createMilkdown';
import type { RefObject } from 'react';

interface LinkTarget {
  snapshot: MilkdownLinkSnapshot;
  anchor: HTMLAnchorElement | null;
  keyboard: boolean;
  returnFocus: HTMLElement | null;
}

/** One link form per editable editor; navigation and read-only previews are independent. */
export function MilkdownLinkPopover({
  instance,
  rootRef,
}: {
  instance: MilkdownInstance;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [target, setTarget] = useState<LinkTarget | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [text, setText] = useState('');
  const [href, setHref] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLInputElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverBlocked = useRef(false);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);

  function cancelClose() {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }

  function close(restoreFocus = false) {
    cancelClose();
    const previous = targetRef.current;
    // Document/overlay replacement can emit pointerover under a stationary
    // pointer. Only actual pointer movement re-arms hover after dismissal.
    if (previous) hoverBlocked.current = true;
    targetRef.current = null;
    setTarget(null);
    if (restoreFocus && previous) {
      instance.restoreLinkSelection(previous.snapshot);
      if (
        previous.returnFocus?.isConnected &&
        rootRef.current?.contains(previous.returnFocus)
      )
        previous.returnFocus.focus({ preventScroll: true });
      else instance.focus();
    }
  }

  function scheduleClose() {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (
        !panelRef.current?.contains(document.activeElement) &&
        !targetRef.current?.keyboard
      )
        close();
    }, 200);
  }

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const anchorAt = (event: Event) => {
      const anchor =
        event.target instanceof Element
          ? event.target.closest('a[href]')
          : null;
      return anchor instanceof HTMLAnchorElement &&
        root.contains(anchor) &&
        anchor.closest('.ProseMirror')
        ? anchor
        : null;
    };
    const open = (
      anchor: HTMLAnchorElement | null,
      keyboard: boolean,
      requested?: MilkdownLinkSnapshot,
    ) => {
      cancelClose();
      const current = targetRef.current;
      if (
        !keyboard &&
        (current?.keyboard ||
          panelRef.current?.contains(document.activeElement))
      )
        return;
      if (!keyboard && current?.anchor === anchor) return;
      const snapshot =
        requested ?? instance.getLinkSnapshot(anchor ?? undefined);
      if (!snapshot) return;
      const rect =
        anchor?.getBoundingClientRect() ?? instance.getLinkClientRect(snapshot);
      if (!rect) return;
      const next: LinkTarget = {
        snapshot,
        anchor,
        keyboard,
        returnFocus:
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
      };
      targetRef.current = next;
      setTarget(next);
      setPosition({ x: rect.left, y: rect.bottom });
      setText(snapshot.text);
      setHref(snapshot.href);
      setError('');
      setCopied(false);
    };
    const unsubscribeRequest = instance.onLinkEditRequested((snapshot) =>
      open(null, true, snapshot),
    );
    const over = (event: PointerEvent) => {
      if (event.buttons || event.pointerType === 'touch') return;
      lastPointer.current ??= { x: event.clientX, y: event.clientY };
      if (hoverBlocked.current) return;
      const anchor = anchorAt(event);
      if (anchor) open(anchor, false);
    };
    const move = (event: PointerEvent) => {
      const previous = lastPointer.current;
      lastPointer.current = { x: event.clientX, y: event.clientY };
      if (
        previous &&
        previous.x === event.clientX &&
        previous.y === event.clientY
      )
        return;
      hoverBlocked.current = false;
      over(event);
    };
    const out = (event: PointerEvent) => {
      if (!anchorAt(event)) return;
      const related = event.relatedTarget;
      if (
        related instanceof Node &&
        (targetRef.current?.anchor?.contains(related) ||
          panelRef.current?.contains(related))
      )
        return;
      scheduleClose();
    };
    const keydown = (event: KeyboardEvent) => {
      const current = targetRef.current;
      if (event.key === 'Escape' && current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        close(
          current.keyboard ||
            Boolean(panelRef.current?.contains(document.activeElement)),
        );
        return;
      }
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'k'
      )
        return;
      if (!(event.target instanceof Node) || !root.contains(event.target))
        return;
      const anchor = anchorAt(event);
      // Capture selection afresh for explicit requests, never reuse a hover target.
      if (!instance.requestLinkEdit(anchor ?? undefined)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    root.addEventListener('pointerover', over);
    root.addEventListener('pointerout', out);
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('keydown', keydown, true);
    // Observe every transaction; document identity alone invalidates the target.
    const unsubscribe = instance.onFormattingUpdated(() => {
      const current = targetRef.current;
      if (current && !instance.isLinkSnapshotCurrent(current.snapshot)) close();
    });
    return () => {
      cancelClose();
      unsubscribe();
      unsubscribeRequest();
      root.removeEventListener('pointerover', over);
      root.removeEventListener('pointerout', out);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('keydown', keydown, true);
    };
    // The listener reads transient targets through refs, not React dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, rootRef]);

  useEffect(() => {
    if (!target) return;
    // Popover is initially hidden while measuring. Focus after its layout
    // update makes the input visible, otherwise Chromium ignores focus().
    const focusFrame = target.keyboard
      ? requestAnimationFrame(() =>
          textRef.current?.focus({ preventScroll: true }),
        )
      : null;
    const updatePosition = () => {
      if (
        !instance.isLinkSnapshotCurrent(target.snapshot) ||
        (target.anchor && !target.anchor.isConnected)
      ) {
        close();
        return;
      }
      const rect =
        target.anchor?.getBoundingClientRect() ??
        instance.getLinkClientRect(target.snapshot);
      if (rect) setPosition({ x: rect.left, y: rect.bottom });
    };
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      if (focusFrame !== null) cancelAnimationFrame(focusFrame);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, target]);

  if (!target) return null;

  function apply(remove = false) {
    if (!target) return;
    if (!instance.isLinkSnapshotCurrent(target.snapshot)) {
      close();
      return;
    }
    if (!remove && !normalizeSafeLinkHref(href)) {
      setError(t('editor.linkInvalidUrl'));
      return;
    }
    if (
      !remove &&
      target.snapshot.textEditable &&
      (!text.trim() || /[\r\n]/.test(text))
    ) {
      setError(t('editor.linkInvalidText'));
      return;
    }
    // A synchronous transaction callback can close the panel during the command.
    const previous = target;
    const changed = instance.editLink(
      target.snapshot,
      remove ? null : href,
      text,
    );
    if (!changed) {
      setError(t('editor.linkEditUnavailable'));
      return;
    }
    close();
    if (
      previous.returnFocus?.isConnected &&
      rootRef.current?.contains(previous.returnFocus)
    )
      previous.returnFocus.focus({ preventScroll: true });
    else instance.focus();
  }

  return (
    <Popover
      position={position}
      contentRef={panelRef}
      dismissOnEscape={false}
      onDismiss={() => close()}
      className="w-72 p-3"
    >
      <form
        role="dialog"
        aria-label={t(
          target.snapshot.kind === 'link'
            ? 'editor.editLink'
            : 'editor.createLink',
        )}
        className="text-fg-default flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        onBlur={(event) => {
          // During blur Chromium has not necessarily focused the next control
          // yet. relatedTarget identifies internal moves without a close race.
          if (!panelRef.current?.contains(event.relatedTarget)) close();
        }}
      >
        <label htmlFor={`${id}-text`} className="text-fg-muted text-xs">
          {t('editor.linkText')}
        </label>
        <TextInput
          ref={textRef}
          id={`${id}-text`}
          value={text}
          readOnly={!target.snapshot.textEditable}
          aria-describedby={
            !target.snapshot.textEditable ? `${id}-structure` : undefined
          }
          onChange={(event) => {
            setText(event.target.value);
            setError('');
          }}
        />
        {!target.snapshot.textEditable ? (
          <p id={`${id}-structure`} className="text-fg-muted text-xs">
            {t('editor.linkKeepStructure')}
          </p>
        ) : null}
        <label htmlFor={`${id}-url`} className="text-fg-muted text-xs">
          {t('editor.linkUrl')}
        </label>
        <TextInput
          id={`${id}-url`}
          value={href}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            setHref(event.target.value);
            setError('');
          }}
        />
        {error ? (
          <p id={`${id}-error`} role="alert" className="text-danger text-xs">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1">
          <Button size="sm" type="submit">
            {t('editor.saveLink')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={target.snapshot.kind !== 'link'}
            onClick={() => {
              const captured = target;
              void copyToClipboard(captured.snapshot.href)
                .then(() => {
                  if (targetRef.current === captured) setCopied(true);
                })
                .catch(() => {
                  if (targetRef.current === captured)
                    setError(t('editor.linkCopyFailed'));
                });
            }}
          >
            {copied ? t('editor.linkCopied') : t('editor.copyLinkAddress')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            disabled={target.snapshot.kind !== 'link'}
            onClick={() => apply(true)}
          >
            {t('editor.removeLink')}
          </Button>
        </div>
      </form>
    </Popover>
  );
}
