// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * ThinkingCard — renders a `kind: 'thinking'` segment of an assistant
 * turn. Standalone thinking uses a summary disclosure; thinking inside an
 * activity shows the full plain text at the same density as tool rows.
 */

import {
  AssistantDisclosure,
  ASSISTANT_ROW_CLASS_NAME,
} from '../AssistantDisclosure';

interface ThinkingCardProps {
  plainText: string;
  inActivity?: boolean;
}

export function ThinkingCard({
  plainText,
  inActivity = false,
}: ThinkingCardProps) {
  if (!plainText) return null;
  const preview = plainText.split('\n')[0] ?? plainText;
  const hasDetails = plainText !== preview || preview.length > 80;

  const body = (
    <div className={inActivity ? ASSISTANT_ROW_CLASS_NAME : 'px-1'}>
      {inActivity ? (
        <span
          aria-hidden
          className="absolute top-1 left-0 flex size-3 items-center justify-center"
        >
          <span className="bg-fg-muted/50 h-1 w-1 rounded-full" />
        </span>
      ) : null}
      <div className="flex flex-col gap-1">
        {plainText.split(/\n{2,}/).map((paragraph, index) => (
          <p key={index} className="wrap-break-word whitespace-pre-wrap">
            {paragraph}
          </p>
        ))}
      </div>
    </div>
  );

  return (
    <div data-assistant-thinking>
      <AssistantDisclosure
        icon={null}
        title={preview}
        titleTooltip={hasDetails ? undefined : preview}
        showHeader={!inActivity}
        bodyClassName={
          inActivity ? '' : 'border-edge-default/40 ml-2 border-l pl-3'
        }
      >
        {inActivity || hasDetails ? body : undefined}
      </AssistantDisclosure>
    </div>
  );
}
