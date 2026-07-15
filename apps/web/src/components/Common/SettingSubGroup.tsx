import React from 'react';

/**
 * Groups settings that belong to — and are revealed by — the control in
 * the row directly above (e.g. a preset's credentials, or an agent's
 * auto-approve toggle). Renders its children in a recessed, tinted inset
 * panel so they read as a nested unit "expanded from" the preceding row
 * rather than as sibling rows.
 */
export const SettingSubGroup: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = '' }) => (
  <div className="px-3 pt-1 pb-2">
    <div
      className={`bg-bg-default overflow-hidden rounded-md ${className}`.trim()}
      role="group"
    >
      {children}
    </div>
  </div>
);
