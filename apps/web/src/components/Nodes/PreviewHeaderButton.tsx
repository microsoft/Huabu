// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Button } from '../Common/Button';

import type { ComponentPropsWithRef } from 'react';

type PreviewHeaderButtonProps = Omit<
  ComponentPropsWithRef<typeof Button>,
  | 'size'
  | 'iconOnly'
  | 'variant'
  | 'tone'
  | 'shape'
  | 'tooltipPlacement'
  | 'title'
> & {
  title: string;
};

/** Shared preview-header chrome; callers own actions and semantic state styles. */
export function PreviewHeaderButton(props: PreviewHeaderButtonProps) {
  return (
    <Button
      {...props}
      variant="ghost"
      tone="neutral"
      size="sm"
      shape="default"
      iconOnly
      tooltipPlacement="bottom"
    />
  );
}
