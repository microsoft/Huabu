import { NodePreviews } from '@/components/Nodes/previews';

import { AiSummaryBanner } from './AiSummaryBanner';

export type PreviewData = {
  type: string;
  data: Record<string, unknown>;
  id?: string; // Optional ID for updates
};

export interface NodePreviewContentProps {
  type: string;
  data: Record<string, unknown>;
  readOnly?: boolean;
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
  const { type, data, ...rest } = props;

  const PreviewComponent = NodePreviews[type];
  const sourceId =
    typeof data.sourceId === 'string' && data.sourceId ? data.sourceId : null;

  if (!PreviewComponent) {
    return <DefaultPreview type={type} />;
  }

  return (
    <div className="flex h-full flex-col">
      {sourceId && <AiSummaryBanner sourceId={sourceId} />}
      <div className="min-h-0 flex-1">
        <PreviewComponent data={data} {...rest} />
      </div>
    </div>
  );
};
