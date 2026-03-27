import { ChevronDown, Plus, Search, Trash2 } from 'lucide-react';

import { Button } from '../Common/Button';
import { Header } from '../Panels/Header';

const variants = ['solid', 'outline', 'ghost'] as const;
const shapes = ['default', 'pill'] as const;
const tones = ['neutral', 'info', 'danger'] as const;
const sizes = ['sm', 'md'] as const;

const toneDescriptions: Record<(typeof tones)[number], string> = {
  neutral: 'Default action styling for standard actions',
  info: 'Highlighted action styling for primary actions',
  danger: 'Destructive styling for risky actions',
};

const sectionDescriptions: Record<(typeof variants)[number], string> = {
  solid: 'Filled buttons with the strongest visual weight.',
  outline: 'Bordered buttons for secondary actions and quiet emphasis.',
  ghost: 'Minimal buttons for toolbars, menus, and low-emphasis actions.',
};

export default function ButtonShowcasePage() {
  return (
    <div className="bg-bg-default flex h-full min-h-0 flex-col">
      <Header>
        <div className="flex min-w-0 items-center gap-3">
          <div>
            <p className="text-fg-subtle text-[11px] font-medium tracking-[0.18em] uppercase">
              Component Showcase
            </p>
            <h1 className="text-fg-default text-lg font-semibold">
              Button Gallery
            </h1>
          </div>
        </div>
      </Header>

      <main className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,var(--color-info-bg),transparent_32%),radial-gradient(circle_at_bottom_right,var(--color-danger-bg),transparent_28%)]" />

        <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8">
          <section className="border-border bg-surface overflow-hidden rounded-3xl border shadow-sm">
            <div className="border-border flex flex-col gap-4 border-b px-6 py-6 md:flex-row md:items-end md:justify-between">
              <div className="max-w-2xl">
                <p className="text-fg-subtle mb-2 text-xs tracking-[0.16em] uppercase">
                  Button API Preview
                </p>
                <h2 className="text-fg-default text-3xl font-semibold tracking-tight">
                  One page for every Button combination
                </h2>
                <p className="text-fg-muted mt-3 text-sm leading-6">
                  This page renders the current Button system across variant,
                  shape, tone, and size so you can validate the API visually
                  instead of reasoning about class strings.
                </p>
              </div>
            </div>

            <div className="grid gap-4 px-6 py-5 md:grid-cols-3">
              <div className="bg-bg-default rounded-2xl px-4 py-4">
                <p className="text-fg-subtle text-xs font-medium tracking-[0.16em] uppercase">
                  Variants
                </p>
                <p className="text-fg-default mt-2 text-2xl font-semibold">
                  {variants.length}
                </p>
                <p className="text-fg-muted mt-1 text-sm">
                  solid, outline, ghost
                </p>
              </div>

              <div className="bg-bg-default rounded-2xl px-4 py-4">
                <p className="text-fg-subtle text-xs font-medium tracking-[0.16em] uppercase">
                  Shapes
                </p>
                <p className="text-fg-default mt-2 text-2xl font-semibold">
                  {shapes.length}
                </p>
                <p className="text-fg-muted mt-1 text-sm">default, pill</p>
              </div>

              <div className="bg-bg-default rounded-2xl px-4 py-4">
                <p className="text-fg-subtle text-xs font-medium tracking-[0.16em] uppercase">
                  Tones × Sizes
                </p>
                <p className="text-fg-default mt-2 text-2xl font-semibold">
                  {tones.length * sizes.length}
                </p>
                <p className="text-fg-muted mt-1 text-sm">
                  36 rendered combinations below
                </p>
              </div>
            </div>
          </section>

          <section className="grid gap-6 xl:grid-cols-3">
            {variants.map((variant) => (
              <article
                key={variant}
                className="border-border bg-surface rounded-3xl border p-5 shadow-sm"
              >
                <div className="mb-5">
                  <p className="text-fg-subtle text-xs font-medium tracking-[0.16em] uppercase">
                    Variant
                  </p>
                  <h3 className="text-fg-default mt-2 text-2xl font-semibold capitalize">
                    {variant}
                  </h3>
                  <p className="text-fg-muted mt-2 text-sm leading-6">
                    {sectionDescriptions[variant]}
                  </p>
                </div>

                <div className="space-y-4">
                  {shapes.map((shape) => (
                    <div key={shape} className="bg-bg-default rounded-2xl p-4">
                      <div className="mb-4 flex items-center justify-between">
                        <div>
                          <p className="text-fg-subtle text-[11px] font-medium tracking-[0.16em] uppercase">
                            Shape
                          </p>
                          <h4 className="text-fg-default mt-1 text-base font-semibold capitalize">
                            {shape}
                          </h4>
                        </div>
                        <div className="text-fg-subtle border-border rounded-full border px-2 py-1 text-[11px]">
                          {tones.length * sizes.length} states
                        </div>
                      </div>

                      <div className="space-y-3">
                        {tones.map((tone) => (
                          <div
                            key={`${variant}-${shape}-${tone}`}
                            className="border-border bg-surface rounded-2xl border p-3"
                          >
                            <div className="mb-3 flex items-start justify-between gap-3">
                              <div>
                                <p className="text-fg-default text-sm font-medium capitalize">
                                  {tone}
                                </p>
                                <p className="text-fg-subtle mt-1 text-xs leading-5">
                                  {toneDescriptions[tone]}
                                </p>
                              </div>
                              <code className="bg-bg-default text-fg-subtle rounded px-2 py-1 text-[11px]">
                                {variant}
                              </code>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              {sizes.map((size) => (
                                <Button
                                  key={`${variant}-${shape}-${tone}-${size}`}
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
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </section>

          <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
            <article className="border-border bg-surface rounded-3xl border p-6 shadow-sm">
              <p className="text-fg-subtle text-xs font-medium tracking-[0.16em] uppercase">
                Common Patterns
              </p>
              <h3 className="text-fg-default mt-2 text-2xl font-semibold">
                Realistic button compositions
              </h3>
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <div className="bg-bg-default rounded-2xl p-4">
                  <p className="text-fg-default mb-3 text-sm font-medium">
                    Toolbar action
                  </p>
                  <Button variant="ghost" tone="neutral" className="gap-1.5">
                    <Search />
                    Inspect
                  </Button>
                </div>

                <div className="bg-bg-default rounded-2xl p-4">
                  <p className="text-fg-default mb-3 text-sm font-medium">
                    Primary call to action
                  </p>
                  <Button variant="solid" tone="info" className="gap-1.5">
                    <Plus />
                    Create Node
                  </Button>
                </div>

                <div className="bg-bg-default rounded-2xl p-4">
                  <p className="text-fg-default mb-3 text-sm font-medium">
                    Filter chip
                  </p>
                  <Button
                    variant="outline"
                    shape="pill"
                    tone="neutral"
                    className="gap-1.5"
                  >
                    Recent
                    <ChevronDown />
                  </Button>
                </div>

                <div className="bg-bg-default rounded-2xl p-4">
                  <p className="text-fg-default mb-3 text-sm font-medium">
                    Destructive action
                  </p>
                  <Button variant="solid" tone="danger" className="gap-1.5">
                    <Trash2 />
                    Delete Canvas
                  </Button>
                </div>
              </div>
            </article>

            <article className="border-border bg-surface rounded-3xl border p-6 shadow-sm">
              <p className="text-fg-subtle text-xs font-medium tracking-[0.16em] uppercase">
                States
              </p>
              <h3 className="text-fg-default mt-2 text-2xl font-semibold">
                Disabled and emphasis checks
              </h3>
              <div className="mt-5 space-y-4">
                <div className="bg-bg-default rounded-2xl p-4">
                  <p className="text-fg-default mb-3 text-sm font-medium">
                    Disabled set
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="solid" tone="neutral" disabled>
                      Disabled neutral
                    </Button>
                    <Button variant="solid" tone="info" disabled>
                      Disabled info
                    </Button>
                    <Button variant="solid" tone="danger" disabled>
                      Disabled danger
                    </Button>
                  </div>
                </div>

                <div className="bg-bg-default rounded-2xl p-4">
                  <p className="text-fg-default mb-3 text-sm font-medium">
                    Quiet versus strong
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="ghost" tone="neutral">
                      Ghost neutral
                    </Button>
                    <Button variant="outline" tone="neutral">
                      Outline neutral
                    </Button>
                    <Button variant="solid" tone="neutral">
                      Solid neutral
                    </Button>
                  </div>
                </div>
              </div>
            </article>
          </section>
        </div>
      </main>
    </div>
  );
}
