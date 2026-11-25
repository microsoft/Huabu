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
}

/**
 * A file path reported by an agent tool call. It opens the file in the Preview
 * Workspace when the conversation runs on a known device and the path is an
 * absolute device path; otherwise it stays plain text.
 */
export function FilePathLink({ path, line }: FilePathLinkProps) {
  const { t } = useTranslation();
  const session = useOptionalChatSession();
  const agentletId = useConversationPreparationStore((state) =>
    session ? state.executions[preparationKey(session)]?.agentletId : undefined,
  );
  const label = line ? `${path}:${line}` : path;
  const reference = { agentletId, path };

  if (!isFileReference(reference)) {
    return <span className="min-w-0 truncate">{label}</span>;
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      // No vertical padding: the row keeps the height of the plain text it replaces.
      className="text-info-fg max-w-full min-w-0 justify-start truncate px-1 py-0 text-xs"
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
