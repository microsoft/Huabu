// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  Download,
  FileText,
  Hand,
  Lasso,
  MousePointer2,
  Plus,
  Redo2,
  Search,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/Common/Button';
import { DragToCanvasHandleButton } from '@/components/Common/DragToCanvasHandleButton';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import { EmptyState } from '@/components/Common/EmptyState';
import { Input } from '@/components/Common/Input';
import { Loading } from '@/components/Common/Loading';
import { Modal } from '@/components/Common/Modal';
import { Popover } from '@/components/Common/Popover';
import { Select } from '@/components/Common/Select';
import { SplitSelect } from '@/components/Common/SplitSelect';
import { TabGroup } from '@/components/Common/TabGroup';
import { toast } from '@/components/Common/Toast';
import { Tooltip } from '@/components/Common/Tooltip';
import { Header } from '@/components/Panels/Header/Header';

// ─── Button constants ───────────────────────────────────────────────────────

const variants = ['solid', 'outline', 'ghost'] as const;
const shapes = ['default', 'pill'] as const;
const tones = ['neutral', 'info', 'danger'] as const;
const sizes = ['sm', 'md'] as const;

const toneDescriptions: Record<(typeof tones)[number], string> = {
  neutral: 'Default action styling for standard actions',
  info: 'Highlighted action styling for primary actions',
  danger: 'Destructive styling for risky actions',
};

const variantDescriptions: Record<(typeof variants)[number], string> = {
  solid: 'Filled buttons with the strongest visual weight.',
  outline: 'Bordered buttons for secondary actions and quiet emphasis.',
  ghost: 'Minimal buttons for toolbars, menus, and low-emphasis actions.',
};

// ─── Shared layout helpers ──────────────────────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-edge-default bg-surface overflow-hidden rounded-lg border">
      <div className="border-edge-default border-b px-6 py-4">
        <h2 className="text-fg-default text-sm font-semibold">{title}</h2>
        <p className="text-fg-muted mt-1 text-sm">{description}</p>
      </div>
      <div className="px-6 py-5">{children}</div>
    </section>
  );
}

function SubSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface rounded-lg p-4">
      <p className="text-fg-muted mb-3 text-xs font-medium">{label}</p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

// ─── Stateful sections ──────────────────────────────────────────────────────

function DropdownMenuDemo() {
  return (
    <SubSection label="Click trigger to open">
      <DropdownMenu
        trigger={
          <Button variant="outline" size="sm">
            Actions
          </Button>
        }
      >
        <DropdownMenuItem icon={<Undo2 size={14} />}>Undo</DropdownMenuItem>
        <DropdownMenuItem icon={<Redo2 size={14} />}>Redo</DropdownMenuItem>
        <div className="border-edge-default my-1 border-t" />
        <DropdownMenuItem icon={<Download size={14} />} shortcut="Ctrl+E">
          Export
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Trash2 size={14} />} disabled>
          Delete (disabled)
        </DropdownMenuItem>
      </DropdownMenu>
    </SubSection>
  );
}

function SelectDemo() {
  const [fruit, setFruit] = useState('apple');
  const [direction, setDirection] = useState('down');

  return (
    <div className="space-y-4">
      <SubSection label="Default (opens down)">
        <Select
          options={[
            { value: 'apple', label: 'Apple' },
            { value: 'banana', label: 'Banana' },
            { value: 'cherry', label: 'Cherry' },
            { value: 'dragonfruit', label: 'Dragonfruit' },
          ]}
          value={fruit}
          onChange={setFruit}
        />
      </SubSection>
      <SubSection label="Pill shape + info tone">
        <Select
          options={[
            { value: 'down', label: 'Downward', icon: <Download size={14} /> },
            { value: 'up', label: 'Upward', icon: <Search size={14} /> },
          ]}
          value={direction}
          onChange={setDirection}
          shape="pill"
          tone="info"
        />
      </SubSection>
      <SubSection label="Disabled">
        <Select
          options={[{ value: 'only', label: 'Only option' }]}
          value="only"
          onChange={() => {}}
          disabled
        />
      </SubSection>
    </div>
  );
}

function SplitSelectDemo() {
  const [tool, setTool] = useState<'select' | 'lasso' | 'pan'>('select');
  const [lastPrimaryAction, setLastPrimaryAction] = useState<
    'select' | 'lasso' | 'pan' | null
  >(null);

  const toolOptions = [
    {
      value: 'select' as const,
      label: 'Select',
      icon: <MousePointer2 size={14} />,
    },
    {
      value: 'lasso' as const,
      label: 'Lasso',
      icon: <Lasso size={14} />,
    },
    {
      value: 'pan' as const,
      label: 'Pan',
      icon: <Hand size={14} />,
    },
  ];

  return (
    <div className="space-y-4">
      <SubSection label="Separated trigger: left side acts, right side opens menu">
        <SplitSelect
          options={toolOptions}
          value={tool}
          onChange={setTool}
          onPrimaryAction={setLastPrimaryAction}
          primaryTitle="Apply current tool"
          menuTitle="Choose tool"
        />
        <span className="text-fg-muted text-sm">
          Active tool: <strong className="text-fg-default">{tool}</strong>
          {' · '}
          Last primary action:{' '}
          <strong className="text-fg-default">
            {lastPrimaryAction ?? 'none'}
          </strong>
        </span>
      </SubSection>
      <SubSection label="Toolbar-style icon only">
        <div className="shadow-bottom bg-surface inline-flex rounded-lg p-1">
          <SplitSelect
            options={toolOptions}
            value={tool}
            onChange={setTool}
            onPrimaryAction={setLastPrimaryAction}
            variant="ghost"
            size="md"
            align="top-left"
            iconOnly
            primaryTitle="Activate current tool"
            menuTitle="Switch tool"
            primaryButtonClassName="text-info bg-bg-default enabled:hover:bg-bg-default"
            menuButtonClassName="enabled:hover:bg-bg-default"
          />
        </div>
      </SubSection>
    </div>
  );
}

function TabGroupDemo() {
  const [tab, setTab] = useState('canvas');

  return (
    <SubSection label="Click to switch tabs">
      <TabGroup
        options={[
          { value: 'canvas', label: 'Canvas' },
          { value: 'sources', label: 'Sources' },
          { value: 'settings', label: 'Settings' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <span className="text-fg-muted text-sm">
        Active: <strong className="text-fg-default">{tab}</strong>
      </span>
    </SubSection>
  );
}

function PopoverDemo() {
  const [isOpen, setIsOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const handleToggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isOpen) {
      setIsOpen(false);
    } else {
      const rect = e.currentTarget.getBoundingClientRect();
      setAnchor({ x: rect.left, y: rect.bottom });
      setIsOpen(true);
    }
  };

  return (
    <SubSection label="Click to toggle">
      <Button variant="outline" onClick={handleToggle}>
        Toggle Popover
      </Button>
      {isOpen && anchor && (
        <Popover
          position={anchor}
          onDismiss={() => setIsOpen(false)}
          offset={{ x: 0, y: 6 }}
          className="w-64 p-4"
        >
          <p className="text-fg-default text-sm font-medium">Popover content</p>
          <p className="text-fg-muted mt-1 text-sm">
            Click outside or press Escape to dismiss.
          </p>
        </Popover>
      )}
    </SubSection>
  );
}

function ModalDemo() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <SubSection label="Click to open">
      <Button variant="outline" onClick={() => setIsOpen(true)}>
        Open Modal
      </Button>
      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Example Modal"
        description="This is a modal with title, description, and footer."
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              tone="info"
              size="sm"
              onClick={() => setIsOpen(false)}
            >
              Confirm
            </Button>
          </>
        }
      >
        <p className="text-fg-muted text-sm">Modal body content goes here.</p>
      </Modal>
    </SubSection>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export default function ComponentShowcasePage() {
  return (
    <div className="bg-bg-default flex h-full min-h-0 flex-col">
      <Header>
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-fg-default text-lg font-semibold">
            Common Component Showcase
          </h1>
        </div>
      </Header>

      <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
          {/* ────────────────────── Button ────────────────────── */}
          <Section
            title="Button"
            description="Variant x Shape x Tone x Size matrix (36 text + 36 iconOnly combinations). Disabled states at the end."
          >
            <div className="space-y-6">
              {variants.map((variant) => (
                <div key={variant}>
                  <p className="text-fg-default mb-1 text-sm font-medium capitalize">
                    {variant}
                  </p>
                  <p className="text-fg-muted mb-3 text-xs">
                    {variantDescriptions[variant]}
                  </p>

                  <div className="space-y-3">
                    {shapes.map((shape) => (
                      <div key={shape} className="bg-bg-default rounded-lg p-4">
                        <p className="text-fg-muted mb-3 text-xs font-medium">
                          shape=&quot;{shape}&quot;
                        </p>
                        <div className="space-y-3">
                          {tones.map((tone) => (
                            <div key={`${variant}-${shape}-${tone}`}>
                              <p className="text-fg-subtle mb-2 text-xs">
                                tone=&quot;{tone}&quot; &mdash;{' '}
                                {toneDescriptions[tone]}
                              </p>
                              <div className="flex flex-wrap items-center gap-2">
                                {sizes.map((size) => (
                                  <Button
                                    key={`text-${size}`}
                                    variant={variant}
                                    shape={shape}
                                    tone={tone}
                                    size={size}
                                  >
                                    {tone === 'danger' ? (
                                      <Trash2 />
                                    ) : tone === 'info' ? (
                                      <Plus />
                                    ) : (
                                      <Search />
                                    )}
                                    {size.toUpperCase()}
                                  </Button>
                                ))}
                                {sizes.map((size) => (
                                  <Button
                                    key={`icon-${size}`}
                                    variant={variant}
                                    shape={shape}
                                    tone={tone}
                                    size={size}
                                    iconOnly
                                    title={`${variant} ${shape} ${tone} ${size} iconOnly`}
                                  >
                                    {tone === 'danger' ? (
                                      <Trash2 />
                                    ) : tone === 'info' ? (
                                      <Plus />
                                    ) : (
                                      <Search />
                                    )}
                                  </Button>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <SubSection label="Disabled states">
                <Button variant="solid" disabled>
                  Disabled solid
                </Button>
                <Button variant="outline" tone="info" disabled>
                  Disabled outline
                </Button>
                <Button variant="ghost" tone="danger" disabled>
                  Disabled ghost
                </Button>
              </SubSection>
            </div>
          </Section>

          {/* ────────────────────── Input ────────────────────── */}
          <Section
            title="Input"
            description="Drop-in <input> replacement. Renders the title prop as a Tooltip instead of native browser tooltip."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <SubSection label="Default">
                <Input
                  placeholder="Type something..."
                  className="border-edge-default bg-surface text-fg-default w-full rounded-md border px-3 py-1.5 text-sm outline-none"
                />
              </SubSection>
              <SubSection label="With title (hover for tooltip)">
                <Input
                  placeholder="Hover me"
                  title="This tooltip comes from the title prop"
                  className="border-edge-default bg-surface text-fg-default w-full rounded-md border px-3 py-1.5 text-sm outline-none"
                />
              </SubSection>
              <SubSection label="Disabled">
                <Input
                  placeholder="Disabled input"
                  disabled
                  className="border-edge-default bg-surface text-fg-default w-full rounded-md border px-3 py-1.5 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
                />
              </SubSection>
              <SubSection label="With value">
                <Input
                  defaultValue="Pre-filled value"
                  className="border-edge-default bg-surface text-fg-default w-full rounded-md border px-3 py-1.5 text-sm outline-none"
                />
              </SubSection>
            </div>
          </Section>

          {/* ────────────── DragToCanvasHandleButton ──────────── */}
          <Section
            title="DragToCanvasHandleButton"
            description="Draggable grip-handle button built on Button ghost + iconOnly. Used for drag-to-canvas interactions."
          >
            <div className="flex flex-wrap gap-4">
              <SubSection label="Default (icon-only)">
                <DragToCanvasHandleButton title="Drag to canvas" />
              </SubSection>
              <SubSection label="With children">
                <DragToCanvasHandleButton title="Drag text to canvas">
                  <FileText size={14} />
                </DragToCanvasHandleButton>
              </SubSection>
            </div>
          </Section>

          {/* ────────────────── DropdownMenuItem ──────────────── */}
          <Section
            title="DropdownMenuItem"
            description="Styled menu item using Button ghost + role=menuitem. Supports icon, label, shortcut hint, and disabled state."
          >
            <SubSection label="Simulated menu panel">
              <div className="border-edge-default bg-surface w-56 overflow-hidden rounded-md border py-1 shadow-lg">
                <DropdownMenuItem icon={<Undo2 size={14} />}>
                  Undo
                </DropdownMenuItem>
                <DropdownMenuItem icon={<Redo2 size={14} />}>
                  Redo
                </DropdownMenuItem>
                <div className="border-edge-default my-1 border-t" />
                <DropdownMenuItem
                  icon={<Download size={14} />}
                  shortcut="Ctrl+E"
                >
                  Export Canvas
                </DropdownMenuItem>
                <DropdownMenuItem icon={<Trash2 size={14} />} disabled>
                  Delete (disabled)
                </DropdownMenuItem>
              </div>
            </SubSection>
          </Section>

          {/* ────────────────── DropdownMenu ───────────────── */}
          <Section
            title="DropdownMenu"
            description="Container component that composes a trigger Button with a Popover-based menu panel. Handles open/close, outside-click dismiss, Escape, and re-open guard."
          >
            <DropdownMenuDemo />
          </Section>

          {/* ────────────────────── Select ─────────────────────── */}
          <Section
            title="Select"
            description="Custom select control with Button trigger and Popover option panel. Supports up/down direction, icons, and all Button variants."
          >
            <SelectDemo />
          </Section>

          <Section
            title="SplitSelect"
            description="Split trigger select with a primary action button on the left and a dedicated menu toggle on the right. Useful for select/pan style tool switchers where changing value must not auto-open the menu."
          >
            <SplitSelectDemo />
          </Section>

          {/* ────────────────────── TabGroup ────────────────────── */}
          <Section
            title="TabGroup"
            description="Stateless segmented control for switching between views. Follows design system §3.4 styling."
          >
            <TabGroupDemo />
          </Section>

          {/* ────────────────────── Tooltip ───────────────────── */}
          <Section
            title="Tooltip"
            description="Portal-based tooltip on hover/focus. Positioned above (preferred) or below. Auto-disabled when content is empty."
          >
            <SubSection label="Hover each button">
              <Tooltip content="Short tip">
                <Button variant="outline" size="sm">
                  Short tooltip
                </Button>
              </Tooltip>
              <Tooltip content="This is a longer tooltip message that demonstrates wrapping behavior">
                <Button variant="outline" size="sm">
                  Long tooltip
                </Button>
              </Tooltip>
              <Tooltip content="">
                <Button variant="outline" size="sm">
                  Empty content (no tooltip)
                </Button>
              </Tooltip>
            </SubSection>
          </Section>

          {/* ────────────────────── Popover ───────────────────── */}
          <Section
            title="Popover"
            description="Portal-based floating panel. Fixed positioning with viewport clamping. Dismisses on outside click or Escape."
          >
            <PopoverDemo />
          </Section>

          {/* ────────────────────── Modal ─────────────────────── */}
          <Section
            title="Modal"
            description="Accessible dialog with backdrop blur, scroll lock, focus trap, and Escape/backdrop dismiss."
          >
            <ModalDemo />
          </Section>

          {/* ────────────────────── Toast ─────────────────────── */}
          <Section
            title="Toast"
            description="Imperative toast via toast() function. Five tones (neutral, info, success, warning, danger) shared with Button. Auto-dismisses after 3 seconds."
          >
            <SubSection label="Tones (auto-dismiss)">
              <Button
                variant="solid"
                tone="neutral"
                size="sm"
                onClick={() =>
                  toast('Neutral toast — plain status update', {
                    tone: 'neutral',
                  })
                }
              >
                Neutral
              </Button>
              <Button
                variant="solid"
                tone="info"
                size="sm"
                onClick={() =>
                  toast('Info toast — heads up, nothing wrong', {
                    tone: 'info',
                  })
                }
              >
                Info
              </Button>
              <Button
                variant="solid"
                tone="success"
                size="sm"
                onClick={() =>
                  toast('Success toast — operation completed', {
                    tone: 'success',
                  })
                }
              >
                Success
              </Button>
              <Button
                variant="solid"
                tone="warning"
                size="sm"
                onClick={() =>
                  toast('Warning toast — your input has a problem', {
                    tone: 'warning',
                  })
                }
              >
                Warning
              </Button>
              <Button
                variant="solid"
                tone="danger"
                size="sm"
                onClick={() =>
                  toast('Danger toast — something failed', { tone: 'danger' })
                }
              >
                Danger
              </Button>
            </SubSection>
            <SubSection label="With action button (persistent)">
              <Button
                variant="solid"
                tone="info"
                size="sm"
                onClick={() =>
                  toast('Saved as draft — undo within 10 seconds.', {
                    tone: 'info',
                    duration: 0,
                    action: {
                      label: 'Undo',
                      onClick: () => toast('Undone', { tone: 'success' }),
                    },
                  })
                }
              >
                Info + Undo
              </Button>
              <Button
                variant="solid"
                tone="warning"
                size="sm"
                onClick={() =>
                  toast(
                    'Name "Sketch 1" is already in use. Choose a different name.',
                    {
                      tone: 'warning',
                      duration: 0,
                      action: {
                        label: 'Rename',
                        onClick: () =>
                          toast('Opening rename…', { tone: 'info' }),
                      },
                    },
                  )
                }
              >
                Warning + Rename
              </Button>
              <Button
                variant="solid"
                tone="danger"
                size="sm"
                onClick={() =>
                  toast(
                    "This canvas was modified elsewhere. Your recent edits won't be saved.",
                    {
                      tone: 'danger',
                      duration: 0,
                      action: {
                        label: 'Reload',
                        onClick: () =>
                          toast('Would reload page', { tone: 'neutral' }),
                      },
                    },
                  )
                }
              >
                Danger + Reload
              </Button>
            </SubSection>
            <SubSection label="Dismissible only (no action)">
              <Button
                variant="solid"
                tone="neutral"
                size="sm"
                onClick={() =>
                  toast(
                    'Long-running task started. This toast stays until you dismiss it.',
                    { tone: 'neutral', duration: 0 },
                  )
                }
              >
                Persistent neutral
              </Button>
            </SubSection>
          </Section>

          {/* ────────────────────── Loading ─────────────────────── */}
          <Section
            title="Loading"
            description="Single loading entry point. `variant` chooses spinner / skeleton / brand animation; `layout` chooses inline, block, overlay, or bare indicator placement."
          >
            <div className="space-y-4">
              <SubSection label="Spinner sizes">
                <div className="flex items-center gap-6">
                  <div className="flex flex-col items-center gap-2">
                    <Loading layout="inline" variant="spinner" size="xs" />
                    <span className="text-fg-muted text-xs">xs (12px)</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <Loading layout="inline" variant="spinner" size="sm" />
                    <span className="text-fg-muted text-xs">sm (16px)</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <Loading layout="inline" variant="spinner" size="md" />
                    <span className="text-fg-muted text-xs">md (18px)</span>
                  </div>
                </div>
              </SubSection>
              <SubSection label="Inline: spinner and brand">
                <div className="flex flex-wrap items-center gap-4">
                  <Button variant="solid" disabled>
                    <Loading layout="inline" variant="spinner" size="sm" />
                    Saving…
                  </Button>
                  <Button variant="outline" disabled>
                    <Loading layout="inline" variant="brand" size="sm" />
                    Booting…
                  </Button>
                </div>
              </SubSection>
              <SubSection label="Block: centered status message">
                <div className="bg-bg-default relative h-32 w-full rounded-lg">
                  <Loading
                    variant="spinner"
                    layout="block"
                    size="md"
                    message="Loading canvases…"
                    indicatorClassName="text-fg-subtle"
                  />
                </div>
              </SubSection>
              <SubSection label="Overlay: content materialising">
                <div className="relative h-32 w-full overflow-hidden rounded-lg">
                  <div className="text-fg-muted flex h-full items-center justify-center text-sm">
                    Preview content behind overlay
                  </div>
                  <Loading
                    variant="skeleton"
                    layout="overlay"
                    message="Processing…"
                  />
                </div>
              </SubSection>
              <SubSection label="Brand: full-area transition">
                <div className="bg-bg-default relative h-40 w-full overflow-hidden rounded-lg">
                  <Loading
                    variant="brand"
                    layout="block"
                    size="md"
                    message="Loading workspace…"
                  />
                </div>
              </SubSection>
            </div>
          </Section>

          {/* ────────────────────── EmptyState ──────────────────── */}
          <Section
            title="EmptyState"
            description="Centered empty-list message with optional action slot."
          >
            <div className="space-y-4">
              <SubSection label="Message only">
                <div className="w-full">
                  <EmptyState message="No items found." className="py-10" />
                </div>
              </SubSection>
              <SubSection label="With action">
                <div className="w-full">
                  <EmptyState
                    message="No canvases yet."
                    className="border-edge-default rounded-xl border-2 border-dashed py-10"
                    action={
                      <Button variant="outline" size="sm">
                        <Plus />
                        Create your first canvas
                      </Button>
                    }
                  />
                </div>
              </SubSection>
            </div>
          </Section>
        </div>
      </main>
    </div>
  );
}
