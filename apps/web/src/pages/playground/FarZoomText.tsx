// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Keep Latin words intact while allowing normal CJK wrapping between them. */
export function FarZoomText({ text }: { text: string }) {
  return text
    .split(/([\p{Script=Latin}\p{N}][\p{Script=Latin}\p{M}\p{N}'’_-]*)/u)
    .map((part, index) =>
      index % 2 === 1 ? (
        <span
          key={index}
          data-study-word=""
          style={{
            display: 'inline-block',
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            verticalAlign: 'bottom',
          }}
        >
          {part}
        </span>
      ) : (
        part
      ),
    );
}
