// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import React from 'react';

/**
 * Groups settings that belong to — and are revealed by — the control in
 * the row directly above (e.g. a preset's credentials, or an agent's
 * auto-approve toggle). A quiet inset rule keeps the group subordinate to
 * its parent setting without giving optional controls a card-like weight.
 */
export const SettingSubGroup: React.FC<{
  children: React.ReactNode;
  className?: string;
  density?: 'default' | 'compact';
}> = ({ children, className = '', density = 'default' }) => (
  <div className={density === 'compact' ? 'px-3 pb-1.5' : 'px-3 pt-0.5 pb-2'}>
    <div
      className={`border-edge-default/70 overflow-hidden border-l-2 pl-1 ${className}`.trim()}
      role="group"
    >
      {children}
    </div>
  </div>
);
