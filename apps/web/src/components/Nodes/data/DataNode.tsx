// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Braces, Maximize2, ShieldCheck } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { parseAndNormalizeDataNodeContent } from '@huabu/shared/data-node-validation';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { openPreviewNode } from '@/store/previewWorkspace/actions';

import { NodeWrapper } from '../NodeWrapper';

import type { CanvasDataNodeData } from '../types';
import type { DataNodeSchemaV1 } from '@huabu/shared/data-node-validation';
import type { Node, NodeProps } from '@xyflow/react';

const MAX_PREVIEW_LINES = 8;

function summarizeJsonPreview(
  rawContent: string,
  dataSchema: DataNodeSchemaV1 | null | undefined,
): { valid: boolean; snippet: string; message?: string } {
  const result = parseAndNormalizeDataNodeContent(rawContent, dataSchema);
  if (!result.ok) {
    return {
      valid: false,
      snippet: rawContent.trim(),
      message: result.message,
    };
  }
  const lines = result.formatted.split('\n');
  if (lines.length <= MAX_PREVIEW_LINES) {
    return { valid: true, snippet: result.formatted };
  }
  return {
    valid: true,
    snippet: `${lines.slice(0, MAX_PREVIEW_LINES).join('\n')}\n…`,
  };
}

export const DataNode = memo(
  ({ id, data, selected }: NodeProps<Node<CanvasDataNodeData, 'data'>>) => {
    const { t } = useTranslation();
    const rawContent = typeof data.content === 'string' ? data.content : '{}';
    const dataSchema =
      (data.dataSchema as DataNodeSchemaV1 | undefined) ?? null;
    const summary = useMemo(
      () => summarizeJsonPreview(rawContent, dataSchema),
      [dataSchema, rawContent],
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type="data"
        selected={selected}
        onDoubleClick={() => openPreviewNode(id)}
        actions={
          <FloatingToolbar.ActionButton
            title={t('node.openLargeView')}
            onClick={() => openPreviewNode(id)}
          >
            <Maximize2 />
          </FloatingToolbar.ActionButton>
        }
      >
        <div
          className="text-fg-default flex h-full flex-col gap-2 overflow-hidden p-4 select-none"
          data-testid="data-node-card"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Braces className="text-fg-muted h-4 w-4 shrink-0" />
              <span className="truncate text-sm font-medium">
                {data.label || t('dataNode.defaultLabel')}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {dataSchema && (
                <span className="border-edge-default bg-bg-default text-fg-muted inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium">
                  <ShieldCheck className="h-3 w-3" />
                  {t('dataNode.schemaBadge')}
                </span>
              )}
              {!summary.valid && (
                <span className="text-danger bg-bg-default border-edge-default rounded border px-1.5 py-0.5 text-[11px] font-medium">
                  {t('dataNode.invalidJson')}
                </span>
              )}
            </div>
          </div>

          <pre className="bg-bg-default border-edge-default text-fg-muted min-h-0 flex-1 overflow-hidden rounded border p-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {summary.snippet || t('dataNode.emptyValue')}
          </pre>
        </div>
      </NodeWrapper>
    );
  },
);
DataNode.displayName = 'DataNode';
