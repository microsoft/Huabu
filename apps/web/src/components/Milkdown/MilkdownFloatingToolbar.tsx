// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from '@floating-ui/react';
import {
  Bold,
  Check,
  ChevronDown,
  Code,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Italic,
  Link,
  ListChecks,
  List,
  ListOrdered,
  Minus,
  Quote,
  Sigma,
  Strikethrough,
  Table2,
  Type,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import {
  ACCENT_NONE_TOKEN,
  ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT,
  isAccentToken,
  resolveAccent,
  type AccentToken,
} from '@huabu/shared';

import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';
import { FLOATING_CHROME_PROPS } from '@/components/Common/floatingChrome';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { Input } from '@/components/Common/Input';
import { getAccentTokens } from '@/components/Nodes/accentTokens';
import { useCloseOnEscape } from '@/hooks/useCloseOnEscape';
import { useTrackAttention } from '@/hooks/useTrackAttention';
import { useAnyGlobalModalOpen } from '@/store/globalModalUi';

import type { MilkdownInstance, MilkdownTextRange } from './createMilkdown';
import type {
  MilkdownBlockType,
  MilkdownFormattingState,
  MilkdownInlineMark,
} from './types';
import type { ColorPreset } from '@/components/Common/ColorPicker';
import type { LucideIcon } from 'lucide-react';
import type { RefObject } from 'react';

type MilkdownToolbarPopover =
  | 'block-list'
  | 'text-color'
  | 'background-color'
  | 'link'
  | 'inline-math';

const BLOCK_GROUPS: ReadonlyArray<{
  labelKey: 'text' | 'list' | 'advanced';
  types: readonly MilkdownBlockType[];
}> = [
  {
    labelKey: 'text',
    types: [
      'paragraph',
      'heading-1',
      'heading-2',
      'heading-3',
      'heading-4',
      'heading-5',
      'heading-6',
      'blockquote',
      'divider',
    ],
  },
  { labelKey: 'list', types: ['bullet-list', 'ordered-list', 'task-list'] },
  { labelKey: 'advanced', types: ['code-block', 'table', 'math'] },
];

const BLOCK_ICONS: Record<MilkdownBlockType, LucideIcon> = {
  paragraph: Type,
  'heading-1': Heading1,
  'heading-2': Heading2,
  'heading-3': Heading3,
  'heading-4': Heading4,
  'heading-5': Heading5,
  'heading-6': Heading6,
  blockquote: Quote,
  divider: Minus,
  'bullet-list': List,
  'ordered-list': ListOrdered,
  'task-list': ListChecks,
  'code-block': Code2,
  table: Table2,
  math: Sigma,
};

const INLINE_MARK_ICONS: Record<MilkdownInlineMark, LucideIcon> = {
  bold: Bold,
  italic: Italic,
  strike: Strikethrough,
  inlineCode: Code,
};

const BACKGROUND_COLOR_PICKER_OPTIONS: readonly ColorPreset[] =
  ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT.map((option) => {
    if (!isAccentToken(option.token)) return option;
    const accent = resolveAccent(option.token);
    if (!accent) return option;
    return {
      ...option,
      value: getAccentTokens(accent).highlightBg,
    };
  });

const TEXT_STYLE_MARKS: readonly MilkdownInlineMark[] = [
  'bold',
  'italic',
  'strike',
];

function readFormattingState(
  instance: MilkdownInstance | null,
): MilkdownFormattingState {
  return (
    instance?.getFormattingState() ?? {
      blockType: 'paragraph',
      activeMarks: new Set(),
      textColor: null,
      backgroundColor: null,
    }
  );
}

function readSelectionRect(instance: MilkdownInstance | null): DOMRect | null {
  return instance?.getSelectionClientRect() ?? null;
}

function colorCssForAccentToken(
  token: AccentToken | null,
  kind: 'text' | 'background',
): string | null {
  if (!token) return null;
  const accent = resolveAccent(token);
  if (!accent) return null;
  const tokens = getAccentTokens(accent);
  return kind === 'text' ? tokens.fg : tokens.highlightBg;
}

function TextColorTrigger({ color }: { color: string | null }) {
  return (
    <span
      className="flex h-4 w-4 items-center justify-center rounded-sm text-sm leading-none font-semibold"
      style={{ color: color ?? 'var(--fg-muted)' }}
      aria-hidden="true"
    >
      A
    </span>
  );
}

function BackgroundColorTrigger({ color }: { color: string | null }) {
  return (
    <span
      className="border-edge-default h-4 w-4 rounded-sm border"
      style={{ backgroundColor: color ?? 'transparent' }}
      aria-hidden="true"
    />
  );
}

export interface MilkdownFloatingToolbarProps {
  instance: MilkdownInstance | null;
  /**
   * The surface this toolbar belongs to — normally the host that wraps
   * the editor *and* its sibling overlays, not the editor mount alone.
   * A press or focus landing outside it (and outside floating chrome)
   * means the user moved on, and the toolbar stands down.
   */
  surfaceRef: RefObject<HTMLElement | null>;
  disabled?: boolean;
  className?: string;
}

export function MilkdownFloatingToolbar({
  instance,
  surfaceRef,
  disabled = false,
  className,
}: MilkdownFloatingToolbarProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const [formatting, setFormatting] = useState(() =>
    readFormattingState(instance),
  );
  const [selectionRect, setSelectionRect] = useState(() =>
    readSelectionRect(instance),
  );
  const [openPopover, setOpenPopover] = useState<MilkdownToolbarPopover | null>(
    null,
  );
  const [linkHref, setLinkHref] = useState('');
  const [mathValue, setMathValue] = useState('x');
  // A ProseMirror selection survives blur, so "there is a selection" is
  // not enough to keep the toolbar on screen: after clicking into the
  // chat panel or an adjacent node the highlight is still there and the
  // toolbar would keep floating over unrelated UI. Track whether this
  // editor is still the surface being worked in and stand down when it
  // isn't. The selection is deliberately left intact — coming back
  // should resume where the user left off.
  const [engaged, setEngaged] = useState(true);
  useTrackAttention(
    (target) => surfaceRef.current?.contains(target) ?? false,
    setEngaged,
  );
  // A modal owns the whole window while it is open; a toolbar portalled
  // to `document.body` would otherwise paint on top of its backdrop.
  const hiddenByGlobalModal = useAnyGlobalModalOpen();
  const linkInputRef = useRef<HTMLInputElement>(null);
  const mathInputRef = useRef<HTMLInputElement>(null);
  const linkSelectionRef = useRef<MilkdownTextRange | null>(null);
  const mathSelectionRef = useRef<MilkdownTextRange | null>(null);
  const blockListOpen = openPopover === 'block-list';
  const linkOpen = openPopover === 'link';
  const mathOpen = openPopover === 'inline-math';
  useCloseOnEscape(openPopover !== null, () => setOpenPopover(null));
  const toolbarOpen = selectionRect !== null && engaged && !hiddenByGlobalModal;
  const virtualSelectionReference = useMemo(() => {
    if (!selectionRect) return null;
    return {
      getBoundingClientRect: () => selectionRect,
    };
  }, [selectionRect]);
  const {
    refs: toolbarRefs,
    floatingStyles: toolbarStyles,
    isPositioned: toolbarPositioned,
  } = useFloating({
    open: toolbarOpen,
    placement: 'top',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const {
    refs: blockListRefs,
    floatingStyles: blockListStyles,
    isPositioned: blockListPositioned,
  } = useFloating({
    open: blockListOpen,
    placement: 'bottom-start',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const {
    refs: linkRefs,
    floatingStyles: linkStyles,
    isPositioned: linkPositioned,
  } = useFloating({
    open: linkOpen,
    placement: 'bottom',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const {
    refs: mathRefs,
    floatingStyles: mathStyles,
    isPositioned: mathPositioned,
  } = useFloating({
    open: mathOpen,
    placement: 'bottom',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  useLayoutEffect(() => {
    toolbarRefs.setPositionReference(virtualSelectionReference);
  }, [toolbarRefs, virtualSelectionReference]);

  useEffect(() => {
    setFormatting(readFormattingState(instance));
    setSelectionRect(readSelectionRect(instance));
    if (!instance) return;

    const update = () => {
      setFormatting(readFormattingState(instance));
      setSelectionRect(readSelectionRect(instance));
    };
    const unsubscribeFormatting = instance.onFormattingUpdated((state) => {
      setFormatting(state);
      setSelectionRect(readSelectionRect(instance));
    });
    document.addEventListener('selectionchange', update);
    document.addEventListener('keyup', update, true);
    document.addEventListener('mouseup', update, true);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('keyup', update, true);
      document.removeEventListener('mouseup', update, true);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      unsubscribeFormatting();
    };
  }, [instance]);

  useEffect(() => {
    if (toolbarOpen) return;
    setOpenPopover(null);
  }, [toolbarOpen]);

  useEffect(() => {
    if (!linkOpen) return;
    window.requestAnimationFrame(() => {
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    });
  }, [linkOpen]);

  useEffect(() => {
    if (!mathOpen) return;
    window.requestAnimationFrame(() => {
      mathInputRef.current?.focus();
      mathInputRef.current?.select();
    });
  }, [mathOpen]);

  if (!instance) return null;

  const activeBlock = formatting.blockType;
  const blockGroupLabels = {
    text: t('editor.blockGroups.text'),
    list: t('editor.blockGroups.list'),
    advanced: t('editor.blockGroups.advanced'),
  };
  const blockLabels: Record<MilkdownBlockType, string> = {
    paragraph: t('editor.blocks.paragraph'),
    'heading-1': t('editor.blocks.heading1'),
    'heading-2': t('editor.blocks.heading2'),
    'heading-3': t('editor.blocks.heading3'),
    'heading-4': t('editor.blocks.heading4'),
    'heading-5': t('editor.blocks.heading5'),
    'heading-6': t('editor.blocks.heading6'),
    blockquote: t('editor.blocks.blockquote'),
    divider: t('editor.blocks.divider'),
    'bullet-list': t('editor.blocks.bulletList'),
    'ordered-list': t('editor.blocks.orderedList'),
    'task-list': t('editor.blocks.taskList'),
    'code-block': t('editor.blocks.codeBlock'),
    table: t('editor.blocks.table'),
    math: t('editor.blocks.math'),
  };
  const inlineMarkTitles: Record<MilkdownInlineMark, string> = {
    bold: t('editor.inlineMarks.bold'),
    italic: t('editor.inlineMarks.italic'),
    strike: t('editor.inlineMarks.strikethrough'),
    inlineCode: t('editor.inlineMarks.inlineCode'),
  };
  const ActiveBlockIcon = BLOCK_ICONS[activeBlock];
  const textColorCss = colorCssForAccentToken(formatting.textColor, 'text');
  const backgroundColorCss = colorCssForAccentToken(
    formatting.backgroundColor,
    'background',
  );

  const run = (command: () => void) => {
    if (disabled) return;
    command();
    setFormatting(readFormattingState(instance));
  };

  const selectColor = (
    token: string,
    apply: (token: Parameters<MilkdownInstance['setTextColor']>[0]) => void,
  ) => {
    run(() => {
      if (token === ACCENT_NONE_TOKEN) {
        apply(null);
      } else if (isAccentToken(token)) {
        apply(token);
      }
    });
  };

  const applyLink = () => {
    run(() => instance.setLink(linkHref, linkSelectionRef.current));
    linkSelectionRef.current = null;
    setLinkHref('');
    setOpenPopover(null);
  };

  const clearLink = () => {
    run(() => instance.setLink(null, linkSelectionRef.current));
    linkSelectionRef.current = null;
    setLinkHref('');
    setOpenPopover(null);
  };

  const applyInlineMath = () => {
    run(() => instance.setInlineMath(mathValue, mathSelectionRef.current));
    mathSelectionRef.current = null;
    setMathValue('x');
    setOpenPopover(null);
  };

  const toolbar = (
    <FloatingToolbar
      className={cn('w-fit max-w-full flex-wrap', className)}
      onMouseDown={(event) => event.preventDefault()}
    >
      <FloatingToolbar.Group>
        <div ref={blockListRefs.setReference} className="flex items-center">
          <Button
            variant="ghost"
            size="sm"
            title={t('editor.blockType')}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              setOpenPopover((open) =>
                open === 'block-list' ? null : 'block-list',
              );
            }}
            className="text-fg-muted hover:bg-bg-default gap-1"
          >
            <ActiveBlockIcon className="size-3.5" />
            <span className="text-xs">{blockLabels[activeBlock]}</span>
            <ChevronDown className="size-3" />
          </Button>
        </div>
      </FloatingToolbar.Group>

      {blockListOpen
        ? createPortal(
            <>
              <div
                role="presentation"
                className="fixed inset-0 z-40"
                {...FLOATING_CHROME_PROPS}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenPopover(null);
                }}
              />
              {/* Handlers below only isolate the popover from the editor. */}
              {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events */}
              <div
                ref={blockListRefs.setFloating}
                {...FLOATING_CHROME_PROPS}
                className="border-edge-default shadow-bottom bg-surface z-50 flex max-h-64 min-w-48 flex-col gap-1 overflow-y-auto rounded-md border p-1"
                role="menu"
                tabIndex={-1}
                style={{
                  ...blockListStyles,
                  visibility: blockListPositioned ? 'visible' : 'hidden',
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                {BLOCK_GROUPS.map((group) => (
                  <div key={group.labelKey} className="flex flex-col gap-1">
                    <div className="text-fg-subtle px-2 pt-1 pb-0.5 text-[11px] leading-none font-semibold">
                      {blockGroupLabels[group.labelKey]}
                    </div>
                    {group.types.map((type) => {
                      const Icon = BLOCK_ICONS[type];
                      return (
                        <Button
                          key={type}
                          variant="ghost"
                          size="sm"
                          title={blockLabels[type]}
                          onClick={() => {
                            run(() => instance.setBlockType(type));
                            setOpenPopover(null);
                          }}
                          className={cn(
                            'h-7 w-full justify-start gap-2 px-2',
                            type === activeBlock
                              ? 'text-info bg-info-bg enabled:hover:bg-info-bg'
                              : 'text-fg-muted hover:bg-bg-default',
                          )}
                        >
                          <Icon className="size-3.5" />
                          <span className="text-xs">{blockLabels[type]}</span>
                        </Button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </>,
            document.body,
          )
        : null}

      <FloatingToolbar.Divider />

      <FloatingToolbar.Group>
        {TEXT_STYLE_MARKS.map((mark) => {
          const Icon = INLINE_MARK_ICONS[mark];
          return (
            <FloatingToolbar.ToggleButton
              key={mark}
              active={formatting.activeMarks.has(mark)}
              title={inlineMarkTitles[mark]}
              disabled={disabled}
              onClick={() => run(() => instance.toggleMark(mark))}
            >
              <Icon />
            </FloatingToolbar.ToggleButton>
          );
        })}
      </FloatingToolbar.Group>

      <FloatingToolbar.Divider />

      <FloatingToolbar.Group>
        <FloatingToolbar.ColorPicker
          colors={ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT}
          value={formatting.textColor ?? ACCENT_NONE_TOKEN}
          onSelect={(token) => selectColor(token, instance.setTextColor)}
          title={t('editor.textColor')}
          open={openPopover === 'text-color'}
          onOpenChange={(open) => setOpenPopover(open ? 'text-color' : null)}
        >
          <TextColorTrigger color={textColorCss} />
        </FloatingToolbar.ColorPicker>
        <FloatingToolbar.ColorPicker
          colors={BACKGROUND_COLOR_PICKER_OPTIONS}
          value={formatting.backgroundColor ?? ACCENT_NONE_TOKEN}
          onSelect={(token) => selectColor(token, instance.setBackgroundColor)}
          title={t('editor.highlightColor')}
          open={openPopover === 'background-color'}
          onOpenChange={(open) =>
            setOpenPopover(open ? 'background-color' : null)
          }
        >
          <BackgroundColorTrigger color={backgroundColorCss} />
        </FloatingToolbar.ColorPicker>
      </FloatingToolbar.Group>

      <FloatingToolbar.Divider />

      <FloatingToolbar.Group>
        <div ref={linkRefs.setReference} className="flex items-center">
          <FloatingToolbar.ActionButton
            title={t('editor.link')}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              setOpenPopover((open) => {
                const nextOpen = open === 'link' ? null : 'link';
                if (nextOpen) {
                  const activeLink = instance.getActiveLink();
                  linkSelectionRef.current =
                    activeLink?.range ?? instance.getSelectionRange();
                  setLinkHref(activeLink?.href ?? '');
                } else {
                  linkSelectionRef.current = null;
                }
                return nextOpen;
              });
            }}
          >
            <Link />
          </FloatingToolbar.ActionButton>
        </div>
        <FloatingToolbar.ToggleButton
          active={formatting.activeMarks.has('inlineCode')}
          title={inlineMarkTitles.inlineCode}
          disabled={disabled}
          onClick={() => run(() => instance.toggleMark('inlineCode'))}
        >
          <Code />
        </FloatingToolbar.ToggleButton>
        <div ref={mathRefs.setReference} className="flex items-center">
          <FloatingToolbar.ActionButton
            title={t('editor.inlineMath')}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              setOpenPopover((open) => {
                const nextOpen = open === 'inline-math' ? null : 'inline-math';
                if (nextOpen) {
                  const activeMath = instance.getActiveInlineMath();
                  const selectionRange = instance.getSelectionRange(true);
                  mathSelectionRef.current =
                    activeMath?.range ?? selectionRange;
                  setMathValue(
                    activeMath?.value ?? instance.getSelectionText() ?? 'x',
                  );
                } else {
                  mathSelectionRef.current = null;
                }
                return nextOpen;
              });
            }}
          >
            <Sigma />
          </FloatingToolbar.ActionButton>
        </div>
      </FloatingToolbar.Group>

      {linkOpen
        ? createPortal(
            <>
              <div
                role="presentation"
                className="fixed inset-0 z-40"
                {...FLOATING_CHROME_PROPS}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenPopover(null);
                }}
              />
              {/* Handlers below only isolate the popover from the editor. */}
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */}
              <form
                ref={linkRefs.setFloating}
                {...FLOATING_CHROME_PROPS}
                className="border-edge-default shadow-bottom bg-surface z-50 flex items-center gap-1 rounded-md border p-1"
                style={{
                  ...linkStyles,
                  visibility: linkPositioned ? 'visible' : 'hidden',
                }}
                onSubmit={(event) => {
                  event.preventDefault();
                  applyLink();
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <Input
                  ref={linkInputRef}
                  value={linkHref}
                  onChange={(event) => setLinkHref(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setOpenPopover(null);
                    }
                  }}
                  placeholder="https://example.com"
                  aria-label={t('editor.linkUrl')}
                  className="border-edge-default bg-bg-default text-fg-default placeholder:text-fg-subtle focus:border-info h-7 w-56 rounded-sm border px-2 text-xs outline-none"
                />
                <Button type="submit" variant="solid" size="sm">
                  {t('actions.apply')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={clearLink}
                >
                  {t('actions.clear')}
                </Button>
              </form>
            </>,
            document.body,
          )
        : null}
      {mathOpen
        ? createPortal(
            <>
              <div
                role="presentation"
                className="fixed inset-0 z-40"
                {...FLOATING_CHROME_PROPS}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenPopover(null);
                }}
              />
              {/* Handlers below only isolate the popover from the editor. */}
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */}
              <form
                ref={mathRefs.setFloating}
                {...FLOATING_CHROME_PROPS}
                className="border-edge-default shadow-bottom bg-surface z-50 flex items-center gap-1 rounded-md border p-1"
                style={{
                  ...mathStyles,
                  visibility: mathPositioned ? 'visible' : 'hidden',
                }}
                onSubmit={(event) => {
                  event.preventDefault();
                  applyInlineMath();
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <Input
                  ref={mathInputRef}
                  value={mathValue}
                  onChange={(event) => setMathValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setOpenPopover(null);
                    }
                  }}
                  placeholder="x + y"
                  aria-label={t('editor.inlineMath')}
                  className="border-edge-default bg-bg-default text-fg-default placeholder:text-fg-subtle focus:border-info h-7 w-56 rounded-sm border px-2 font-mono text-xs outline-none"
                />
                <Button
                  type="submit"
                  variant="solid"
                  size="sm"
                  iconOnly
                  title={t('editor.applyInlineMath')}
                >
                  <Check className="size-3.5" />
                </Button>
              </form>
            </>,
            document.body,
          )
        : null}
    </FloatingToolbar>
  );

  if (!toolbarOpen) return null;

  return createPortal(
    <div
      ref={toolbarRefs.setFloating}
      {...FLOATING_CHROME_PROPS}
      style={{
        ...toolbarStyles,
        zIndex: 1000,
        visibility: toolbarPositioned ? 'visible' : 'hidden',
      }}
    >
      {toolbar}
    </div>,
    document.body,
  );
}
