// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { cn } from '@/components/Common/cn';

interface SettingControlProps {
  children: React.ReactNode;
  className?: string;
}

/** Standard width and shrink behavior for controls in Settings rows. */
export function SettingControl({ children, className }: SettingControlProps) {
  return <div className={cn('w-72 min-w-0', className)}>{children}</div>;
}
