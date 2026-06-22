import { ChevronDown } from 'lucide-react';
import React, { useState } from 'react';

interface SettingSectionProps {
  /** Section heading shown above the card. */
  title: string;
  children: React.ReactNode;
  /**
   * When true, renders a ghost chevron next to the title and lets the
   * user collapse the card by clicking the heading. Defaults to `false`
   * so existing non-collapsible sections keep their current behaviour.
   */
  collapsible?: boolean;
  /**
   * Initial collapsed state when {@link collapsible} is true. Defaults
   * to `false` (i.e. expanded on first render).
   */
  defaultCollapsed?: boolean;
}

/**
 * A titled settings section. The title sits outside the card, and the children
 * (typically {@link SettingRow}s) are rendered inside a single rounded card
 * with dividers automatically applied between rows.
 *
 * Pass {@link collapsible} to turn the heading into a toggle button with a
 * chevron icon; the card hides when collapsed.
 */
export const SettingSection: React.FC<SettingSectionProps> = ({
  title,
  children,
  collapsible = false,
  defaultCollapsed = false,
}) => {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const isCollapsed = collapsible && collapsed;

  return (
    <section className="mb-4 last:mb-0">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          className="text-fg-muted hover:text-fg-default mb-1.5 flex items-center gap-1 px-1 text-xs font-medium"
        >
          <span>{title}</span>
          <ChevronDown
            size={12}
            className={`shrink-0 transition-transform ${collapsed ? '-rotate-90' : ''}`}
          />
        </button>
      ) : (
        <h4 className="text-fg-muted mb-1.5 px-1 text-xs font-medium">
          {title}
        </h4>
      )}
      {!isCollapsed && (
        <div className="bg-surface divide-edge-default ring-edge-default/50 divide-y overflow-hidden rounded-md shadow-sm ring-1">
          {children}
        </div>
      )}
    </section>
  );
};
