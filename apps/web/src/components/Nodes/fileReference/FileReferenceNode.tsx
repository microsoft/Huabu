// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { FileText, Maximize2 } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { isFileReference } from '@huabu/shared';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { openPreviewNode } from '@/store/previewWorkspace/actions';

import { NodeWrapper } from '../NodeWrapper';

import type { FileReferenceNodeData } from '@huabu/shared';
import type { Node, NodeProps } from '@xyflow/react';

export const FileReferenceNode = memo(
  ({
    id,
    data,
    selected,
  }: NodeProps<
    Node<FileReferenceNodeData & Record<string, unknown>, 'fileReference'>
  >) => {
    const { t } = useTranslation();
    const source = isFileReference(data.fileReference)
      ? data.fileReference
      : null;
    return (
      <NodeWrapper
        id={id}
        data={data}
        type="fileReference"
        selected={selected}
        actions={
          <FloatingToolbar.ActionButton
            title={t('node.openLargeView')}
            onClick={() => openPreviewNode(id)}
          >
            <Maximize2 />
          </FloatingToolbar.ActionButton>
        }
      >
        <div className="text-fg-default flex h-full flex-col justify-center gap-2 overflow-hidden p-4">
          <FileText className="text-fg-muted h-6 w-6" />
          <div className="truncate font-medium">
            {data.label || t('files.file')}
          </div>
          <div className="text-fg-muted truncate text-xs">
            {source?.deviceName ?? source?.agentletId}
          </div>
          <div className="text-fg-muted line-clamp-3 text-xs break-all">
            {source?.path ?? t('files.invalidReference')}
          </div>
          <div className="text-fg-subtle text-xs">
            {t('files.referenceOnly')}
          </div>
        </div>
      </NodeWrapper>
    );
  },
);
