// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  NODE_CONTROL_CHROME,
  NODE_RESIZE_GRIP_STYLE,
} from '@/config/nodeInteractionChrome';

import type { ComponentProps } from 'react';

type Props = ComponentProps<'span'> & { isNotMouse: boolean };

/** Visual square only; native or group controls own the larger hit region. */
export function ResizeGrip({ isNotMouse, style, ...props }: Props) {
  const size = NODE_CONTROL_CHROME.size[isNotMouse ? 'touch' : 'mouse'];
  return (
    <span
      {...props}
      aria-hidden
      data-resize-grip
      style={{
        ...style,
        ...NODE_RESIZE_GRIP_STYLE,
        display: 'block',
        pointerEvents: 'none',
        width: size,
        height: size,
      }}
    />
  );
}
