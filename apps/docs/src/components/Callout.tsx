// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Long-format callout strip — used for tips, warnings and asides
 * inside the body of a section. Spans the full content width.
 */

import { AlertTriangle, Info, Lightbulb } from 'lucide-react';

import { cn } from './cn';

import type { ReactNode } from 'react';

type CalloutTone = 'info' | 'tip' | 'warning';

const toneStyles: Record<CalloutTone, { wrapper: string; icon: typeof Info }> =
  {
    info: {
      wrapper: 'border-blue-200 bg-blue-50/60 text-blue-900',
      icon: Info,
    },
    tip: {
      wrapper: 'border-emerald-200 bg-emerald-50/60 text-emerald-900',
      icon: Lightbulb,
    },
    warning: {
      wrapper: 'border-amber-200 bg-amber-50/60 text-amber-900',
      icon: AlertTriangle,
    },
  };

export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: CalloutTone;
  title?: string;
  children: ReactNode;
}) {
  const { wrapper, icon: Icon } = toneStyles[tone];
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border px-4 py-3 text-[14px] leading-relaxed',
        wrapper,
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 opacity-80" />
      <div className="min-w-0 flex-1">
        {title && (
          <div className="mb-0.5 text-[13px] font-semibold">{title}</div>
        )}
        <div>{children}</div>
      </div>
    </div>
  );
}
