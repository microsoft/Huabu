// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { cn } from '@/components/Common/cn';
import { ATTENTION_COLOR, type AttentionKind } from '@/utils/attention';

/**
 * The badge that says "something here you have not seen", coloured by what
 * it is. It sits just past the top right corner of what it marks, clear of
 * it so that it never covers a letter, and takes no room in the layout: the
 * parent must be `relative`. A caller marking an icon may move it onto the
 * icon's corner through `className`.
 */
export function AttentionDot({
  kind,
  className,
}: {
  kind: AttentionKind;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      data-attention={kind}
      role="img"
      aria-label={t(`attention.${kind}`)}
      style={{ backgroundColor: ATTENTION_COLOR[kind] }}
      className={cn(
        'absolute top-0.5 -right-2 size-1.5 rounded-full',
        className,
      )}
    />
  );
}
