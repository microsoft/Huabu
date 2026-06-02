import React from 'react';

interface SettingSectionProps {
  /** Section heading shown above the card. */
  title: string;
  children: React.ReactNode;
}

/**
 * A titled settings section. The title sits outside the card, and the children
 * (typically {@link SettingRow}s) are rendered inside a single rounded card
 * with dividers automatically applied between rows.
 */
export const SettingSection: React.FC<SettingSectionProps> = ({
  title,
  children,
}) => {
  return (
    <section className="mb-4 last:mb-0">
      <h4 className="text-fg-muted mb-1.5 px-1 text-xs font-medium">{title}</h4>
      <div className="bg-surface divide-edge-default divide-y overflow-hidden rounded-md shadow-sm ring-1 ring-edge-default/50">
        {children}
      </div>
    </section>
  );
};
