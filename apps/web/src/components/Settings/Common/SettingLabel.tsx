// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

interface SettingLabelProps {
  children: React.ReactNode;
  optional?: boolean;
}

/** Consistent label text for Settings rows, including the optional marker. */
export function SettingLabel({
  children,
  optional = false,
}: SettingLabelProps) {
  const { t } = useTranslation();
  return (
    <span>
      {children}
      {optional ? (
        <span className="text-fg-subtle font-normal">
          {' '}
          ({t('settings.optional')})
        </span>
      ) : null}
    </span>
  );
}
