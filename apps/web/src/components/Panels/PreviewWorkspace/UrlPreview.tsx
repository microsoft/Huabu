// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ArrowUpRight, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { normalizeSafeLinkHref } from '@/utils/safeLink';

/** A bridge-free remote page, independent of node ingestion and artifacts. */
export function UrlPreview({ url }: { url: string }) {
  const { t } = useTranslation();
  const href = normalizeSafeLinkHref(url);
  if (!href)
    return <div className="text-fg-subtle p-4">{t('node.invalidUrl')}</div>;
  const address = new URL(href);
  const location = `${address.pathname === '/' ? '' : address.pathname}${address.search}${address.hash}`;

  return (
    <div className="bg-surface flex h-full min-h-0 min-w-0 flex-col">
      <div className="border-edge-default flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
        <div
          className="bg-bg-default flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-xs"
          title={href}
        >
          <Globe
            className="text-fg-subtle size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0 truncate select-text" dir="ltr">
            <span className="text-fg-muted font-medium">{address.host}</span>
            <span className="text-fg-subtle">{location}</span>
          </span>
        </div>
        <Button
          variant="ghost"
          tone="neutral"
          size="sm"
          iconOnly
          className="h-7 w-7 shrink-0"
          title={t('node.openPageExternal')}
          tooltipPlacement="bottom"
          aria-label={t('node.openPageExternal')}
          onClick={() => window.open(href, '_blank', 'noopener,noreferrer')}
        >
          <ArrowUpRight aria-hidden="true" />
        </Button>
      </div>
      <iframe
        key={href}
        src={href}
        title={href}
        className="min-h-0 w-full flex-1 border-0"
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
