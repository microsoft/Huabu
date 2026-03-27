import { NodePreviews } from '@/components/Nodes/previews';

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
  const { type, ...rest } = props;

  const PreviewComponent = NodePreviews[type];

  if (!PreviewComponent) {
    return <DefaultPreview type={type} />;
  }

  return <PreviewComponent {...rest} />;
};
