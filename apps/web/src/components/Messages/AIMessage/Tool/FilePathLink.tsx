// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { isFileReference } from '@huabu/shared';

import { Button } from '@/components/Common/Button';
import { useOptionalChatSession } from '@/hooks/useChatSession';
import {
  preparationKey,
  useConversationPreparationStore,
} from '@/store/conversationPreparation';
import { openPreviewFile } from '@/store/previewWorkspace/actions';

interface FilePathLinkProps {
  path: string;
  line?: number | null;
  /** Show only the file name; the full path stays in the tooltip. */
  compact?: boolean;
}

/**
 * A file path reported by an agent tool call. It opens the file in the Preview
 * Workspace when the conversation runs on a known device and the path is an
 * absolute device path; otherwise it stays plain text.
 */
export function FilePathLink({ path, line, compact }: FilePathLinkProps) {
  const { t } = useTranslation();
  const session = useOptionalChatSession();
  const agentletId = useConversationPreparationStore((state) =>
    session ? state.executions[preparationKey(session)]?.agentletId : undefined,
  );
  const name = compact ? (path.split(/[\\/]/).pop() ?? path) : path;
  const label = line ? `${name}:${line}` : name;
  const reference = { agentletId, path };

  if (!isFileReference(reference)) {
    return (
      <span className="min-w-0 truncate" title={compact ? path : undefined}>
        {label}
      </span>
    );
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-info-fg max-w-full min-w-0 justify-start truncate px-1 text-xs"
      // The tooltip wrapper is the flex item: unconstrained, a long path would
      // push past a narrow Chat panel instead of truncating.
      tooltipWrapperClassName="inline-flex max-w-full min-w-0"
      title={t('messages.openFile', { path })}
      onClick={(event) => {
        event.stopPropagation();
        openPreviewFile(reference, {
          threadId: session?.threadId,
          nodeId: session?.conversationView?.conversationOwner.nodeId,
        });
      }}
    >
      <span className="truncate">{label}</span>
    </Button>
  );
}
