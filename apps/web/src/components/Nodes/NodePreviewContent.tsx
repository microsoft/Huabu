// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { NodePreviews } from '@/components/Nodes/previews';

import { AiSummaryBanner } from './AiSummaryBanner';

export type PreviewData = {
  type: string;
  data: Record<string, unknown>;
  id?: string; // Optional ID for updates
};

export interface NodePreviewContentProps {
  /** Canvas node id, when bound to a real node. */
  id?: string;
  /** Runtime identity used to restore this Preview target's scroll offset. */
  scrollViewKey?: string;
  type: string;
  data: Record<string, unknown>;
  readOnly?: boolean;
  focusRequestNonce?: number;
  onFocusRequestHandled?: (nonce: number) => void;
  onContentChange?: (newContent: string) => void;
  onDataChange?: (patch: Record<string, unknown>) => void;
}

const DefaultPreview = ({ type }: { type: string }) => {
  return (
    <div className="text-fg-muted flex h-full w-full items-center justify-center text-sm">
      Preview not available for {type}
    </div>
  );
};

export const NodePreviewContent = (props: NodePreviewContentProps) => {
  const { type, data, id, ...rest } = props;

  const PreviewComponent = NodePreviews[type];

  if (!PreviewComponent) {
    return <DefaultPreview type={type} />;
  }

  const summary =
    typeof data.summary === 'string' ? (data.summary as string) : null;
  const keywords = Array.isArray(data.keywords)
    ? (data.keywords as string[])
    : null;

  return (
    <div className="flex h-full flex-col">
      <AiSummaryBanner key={id} summary={summary} keywords={keywords} />
      <div className="relative min-h-0 flex-1">
        <PreviewComponent id={id} data={data} {...rest} />
      </div>
    </div>
  );
};
