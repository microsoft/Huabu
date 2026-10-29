// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { PointerSensor, type PointerSensorProps } from '@dnd-kit/core';

export function subscribeToTabDragInterruption(
  cancel: () => void,
  ownerDocument: Document = document,
  ownerWindow: Window = window,
): () => void {
  const cancelOnHidden = () => {
    if (ownerDocument.visibilityState === 'hidden') cancel();
  };
  ownerWindow.addEventListener('blur', cancel);
  ownerDocument.addEventListener('visibilitychange', cancelOnHidden);
  return () => {
    ownerWindow.removeEventListener('blur', cancel);
    ownerDocument.removeEventListener('visibilitychange', cancelOnHidden);
  };
}

export class TabPointerSensor extends PointerSensor {
  constructor(props: PointerSensorProps) {
    let unsubscribe = () => {};
    const onCancel = () => {
      unsubscribe();
      props.onCancel();
    };
    const onEnd = () => {
      unsubscribe();
      props.onEnd();
    };
    const onAbort = (id: Parameters<PointerSensorProps['onAbort']>[0]) => {
      unsubscribe();
      props.onAbort(id);
    };

    super({ ...props, onAbort, onCancel, onEnd });

    const ownerDocument =
      (
        props.event.target as
          | (EventTarget & { ownerDocument?: Document })
          | null
      )?.ownerDocument ?? document;
    unsubscribe = subscribeToTabDragInterruption(
      () => {
        // Cancel the sensor itself so pending activation and listeners are cleared too.
        ownerDocument.dispatchEvent(new Event('pointercancel'));
      },
      ownerDocument,
      ownerDocument.defaultView ?? window,
    );
  }
}
