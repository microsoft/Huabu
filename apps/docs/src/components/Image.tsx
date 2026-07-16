// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Image / GIF embed with optional caption.
 *
 * Accepts the same `src` types as a plain `<img>` (URL string or a
 * bundler-imported asset) and wraps the result in a soft, bordered
 * frame so screenshots feel intentional rather than dropped in.
 */

import { cn } from './cn';
import { withBasePath } from '../basePath';

type DocImageProps = {
  src: string;
  alt: string;
  caption?: string;
  className?: string;
};

export function DocImage({ src, alt, caption, className }: DocImageProps) {
  const resolvedSrc = src.startsWith('/') ? withBasePath(src) : src;
  return (
    <figure
      className={cn(
        'overflow-hidden rounded-xl border border-gray-200 bg-white',
        className,
      )}
    >
      <img src={resolvedSrc} alt={alt} className="block h-auto w-full" />
      {caption && (
        <figcaption className="border-t border-gray-200 bg-gray-50 px-4 py-2 text-[12px] text-gray-600">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}
