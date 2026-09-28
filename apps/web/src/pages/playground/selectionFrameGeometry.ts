// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export type SpecimenKind = 'image' | 'text' | 'card';
export type ResizeHandle = 'tl' | 'tr' | 'bl' | 'br' | 'left' | 'right';
export interface SpecimenBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Local proposal geometry; never writes production canvas state. */
export function resizeSpecimen(
  box: SpecimenBox,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  kind: SpecimenKind,
): SpecimenBox {
  const left = handle === 'left' || handle === 'tl' || handle === 'bl';
  const top = handle === 'tl' || handle === 'tr';
  let width = Math.max(140, box.width + (left ? -dx : dx));
  let height =
    kind === 'text' ? box.height : Math.max(100, box.height + (top ? -dy : dy));
  if (kind === 'image') {
    const scale = Math.max(
      140 / box.width,
      100 / box.height,
      1 +
        ((left ? -dx : dx) * box.width + (top ? -dy : dy) * box.height) /
          (box.width ** 2 + box.height ** 2),
    );
    width = box.width * scale;
    height = box.height * scale;
  }
  return {
    x: left ? box.x + box.width - width : box.x,
    y: top ? box.y + box.height - height : box.y,
    width,
    height,
  };
}

export function connectionAnchor(
  box: SpecimenBox,
  toward: { x: number; y: number },
) {
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const factor =
    1 /
    Math.max(
      Math.abs(dx) / (box.width / 2),
      Math.abs(dy) / (box.height / 2),
      1,
    );
  return { x: center.x + dx * factor, y: center.y + dy * factor };
}
