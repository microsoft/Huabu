import clsx from 'clsx';
import {
  MousePointer2,
  Hand,
  LayoutDashboard,
  UploadCloud,
  Link as LinkIcon,
  Sprout,
  Sparkles,
  Undo2,
  Redo2,
  Trash2,
} from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';

import { uploadImage, uploadPdf, uploadVideo } from '@/api/artifact';
import { useIsTouch } from '@/hooks/useInputMode';
import { useIntentStore } from '@/store/intentStore';

import { NODE_ICON } from '../../../config/nodeIcons.ts';
import useCanvasStore from '../../../store/canvasStore.ts';
import { detectNodeType } from '../../../utils/io/media.ts';
import { Button } from '../../Common/Button.tsx';
import { Modal } from '../../Common/Modal.tsx';

import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent';

interface NodeToolbarProps {
  activeTool: 'select' | 'pan';
  onToolChange: (tool: 'select' | 'pan') => void;
}

export const NodeToolbar = ({ activeTool, onToolChange }: NodeToolbarProps) => {
  const addNodes = useCanvasStore((s) => s.addNodes);
  const pendingNodeType = useCanvasStore((s) => s.pendingNodeType);
  const setPendingNodeType = useCanvasStore((s) => s.setPendingNodeType);
  const layoutAll = useCanvasStore((s) => s.layoutAll);
  const autoLayoutEnabled = useCanvasStore((s) => s.autoLayoutEnabled);
  const toggleAutoLayout = useCanvasStore((s) => s.toggleAutoLayout);

  // Touch-mode undo / redo / delete
  const isTouch = useIsTouch();
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const disconnectEdges = useCanvasStore((s) => s.disconnectEdges);

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const intentButtonRef = useRef<HTMLDivElement>(null);

  const intentOpen = useIntentStore((s) => s.isOpen);

  // State
  const [activeModal, setActiveModal] = useState<'upload' | 'link' | null>(
    null,
  );
  const [linkText, setLinkText] = useState('');

  const getImageDimensions = (
    file: File,
  ): Promise<{ width: number; height: number }> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
        URL.revokeObjectURL(img.src);
      };
      img.onerror = reject;
    });
  };

  const getVideoDimensions = (
    file: File,
  ): Promise<{ width: number; height: number }> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.src = URL.createObjectURL(file);
      video.onloadedmetadata = () => {
        resolve({ width: video.videoWidth, height: video.videoHeight });
        URL.revokeObjectURL(video.src);
      };
      video.onerror = reject;
    });
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setActiveModal(null);

    const inputs = (
      await Promise.all(
        Array.from(files).map(async (file): Promise<AddNodeInput | null> => {
          const type = detectNodeType(file.name);

          try {
            let url = '';
            let naturalDimensions:
              | { width: number; height: number }
              | undefined;

            if (type === 'image') {
              const [uploadedUrl, dims] = await Promise.all([
                uploadImage(file),
                getImageDimensions(file),
              ]);
              url = uploadedUrl;
              naturalDimensions = dims;
            } else if (type === 'video') {
              const [uploadedUrl, dims] = await Promise.all([
                uploadVideo(file),
                getVideoDimensions(file),
              ]);
              url = uploadedUrl;
              naturalDimensions = dims;
            } else if (type === 'pdf') {
              url = await uploadPdf(file);
            } else if (type === 'note') {
              const content = await file.text();
              return {
                nodeType: 'note',
                data: {
                  content,
                  label: file.name,
                  origin: { type: 'user-uploaded' },
                },
              };
            }

            return {
              nodeType: type,
              data: {
                type,
                src: url,
                label: file.name,
                origin: { type: 'user-uploaded' },
              },
              ...(naturalDimensions ? { naturalDimensions } : {}),
            };
          } catch (error) {
            console.error(`Failed to upload ${file.name}:`, error);
            return null;
          }
        }),
      )
    ).filter((input): input is AddNodeInput => input !== null);

    if (inputs.length > 0) {
      addNodes(inputs);
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleLinkSubmit = () => {
    if (!linkText.trim()) return;

    const lines = linkText.split('\n');

    const inputs = lines.flatMap((line): AddNodeInput[] => {
      const url = line.trim();
      if (!url) return [];

      const finalUrl = url.startsWith('http') ? url : `https://${url}`;
      const type = detectNodeType(finalUrl);

      return [
        {
          nodeType: type,
          data: {
            type,
            src: finalUrl,
            origin: { type: 'user-created' },
          },
        },
      ];
    });

    if (inputs.length > 0) {
      addNodes(inputs);
    }

    setLinkText('');
    setActiveModal(null);
  };

  return (
    <>
      <div className="text-fg-muted shadow-bottom bg-surface pointer-events-auto relative flex w-max items-center gap-1.5 rounded-lg border-0 px-4 py-2">
        {/* Group 1: Tools */}
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            iconOnly
            title="Select"
            className={clsx(
              activeTool === 'select' && 'text-info bg-bg-default',
            )}
            onClick={() => onToolChange('select')}
          >
            <MousePointer2 />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            title="Pan"
            className={clsx(activeTool === 'pan' && 'text-info bg-bg-default')}
            onClick={() => onToolChange('pan')}
          >
            <Hand />
          </Button>
        </div>

        <div className="bg-border mx-1 h-4 w-px" />

        {/* Group 2: Nodes */}
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            iconOnly
            title="Frame"
            className={clsx(
              pendingNodeType === 'frame' && 'text-info bg-bg-default',
            )}
            onClick={() =>
              setPendingNodeType(pendingNodeType === 'frame' ? null : 'frame')
            }
          >
            <NODE_ICON.frame />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            title="Note"
            className={clsx(
              pendingNodeType === 'note' && 'text-info bg-bg-default',
            )}
            onClick={() =>
              setPendingNodeType(pendingNodeType === 'note' ? null : 'note')
            }
          >
            <NODE_ICON.note />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            title="Text"
            className={clsx(
              pendingNodeType === 'text' && 'text-info bg-bg-default',
            )}
            onClick={() =>
              setPendingNodeType(pendingNodeType === 'text' ? null : 'text')
            }
          >
            <NODE_ICON.text />
          </Button>
        </div>

        <div className="bg-border mx-1 h-4 w-px" />

        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            iconOnly
            title="Upload Files"
            className={clsx(
              activeModal === 'upload' && 'text-info bg-bg-default',
            )}
            onClick={() => setActiveModal('upload')}
          >
            <UploadCloud />
          </Button>

          <Button
            variant="ghost"
            iconOnly
            title="Add Links"
            className={clsx(
              activeModal === 'link' && 'text-info bg-bg-default',
            )}
            onClick={() => setActiveModal('link')}
          >
            <LinkIcon />
          </Button>
        </div>

        <div className="bg-border mx-1 h-4 w-px" />

        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            iconOnly
            title="Auto Layout All"
            onClick={() => layoutAll()}
          >
            <LayoutDashboard />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            title={
              autoLayoutEnabled ? 'Disable Auto Layout' : 'Enable Auto Layout'
            }
            onClick={() => toggleAutoLayout()}
            className={clsx(autoLayoutEnabled && 'text-info bg-bg-default')}
          >
            <Sparkles />
          </Button>
        </div>

        <div className="bg-border mx-1 h-4 w-px" />

        <div ref={intentButtonRef} className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            iconOnly
            title="Question"
            className={clsx(
              pendingNodeType === 'prompt' && 'text-info bg-bg-default',
            )}
            onClick={() =>
              setPendingNodeType(pendingNodeType === 'prompt' ? null : 'prompt')
            }
          >
            <NODE_ICON.prompt />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            title="Annotation"
            className={clsx(
              pendingNodeType === 'sketch' && 'text-info bg-bg-default',
            )}
            onClick={() =>
              setPendingNodeType(pendingNodeType === 'sketch' ? null : 'sketch')
            }
          >
            <NODE_ICON.sketch />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            title="Intent"
            className={clsx(intentOpen && 'text-info bg-bg-default')}
            onClick={() => {
              const rect = intentButtonRef.current?.getBoundingClientRect();
              if (rect) {
                useIntentStore
                  .getState()
                  .triggerIntent(rect.left + rect.width / 2, rect.top);
              }
            }}
          >
            <Sprout />
          </Button>
        </div>

        {/* Touch-only: Undo / Redo / Delete (keyboard shortcuts are unreachable) */}
        {isTouch && (
          <>
            <div className="bg-border mx-1 h-4 w-px" />
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                iconOnly
                title="Undo"
                disabled={!canUndo}
                onClick={() => undo()}
              >
                <Undo2 />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                title="Redo"
                disabled={!canRedo}
                onClick={() => redo()}
              >
                <Redo2 />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                title="Delete selected"
                onClick={() => {
                  const selectedNodeIds = nodes
                    .filter((n) => n.selected)
                    .map((n) => n.id);
                  const selectedEdgeIds = edges
                    .filter((e) => e.selected)
                    .map((e) => e.id);
                  if (selectedNodeIds.length > 0) deleteNodes(selectedNodeIds);
                  if (selectedEdgeIds.length > 0)
                    disconnectEdges(selectedEdgeIds);
                }}
              >
                <Trash2 />
              </Button>
            </div>
          </>
        )}
      </div>

      {/* --- Modals --- */}
      {/* 1. File Upload Modal */}
      <Modal
        title="Upload Local Files"
        description="Supports Images, PDFs, and Videos. Select multiple files to upload in batch."
        isOpen={activeModal === 'upload'}
        onClose={() => setActiveModal(null)}
      >
        <div className="flex flex-col items-center justify-center gap-4 pt-2">
          <Button
            variant="outline"
            tone="info"
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex-col border-dashed px-4 py-8"
          >
            <UploadCloud size={24} />
            <span className="text-sm">Click to select files</span>
          </Button>

          {/* Hidden Input for Multiple Selection */}
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            multiple
            accept="image/*,application/pdf,video/mp4,.md,.markdown,text/markdown"
            onChange={handleFileChange}
          />
        </div>
      </Modal>

      {/* 2. Link Input Modal */}
      <Modal
        title="Add Links"
        description="Paste URLs below (one per line)."
        isOpen={activeModal === 'link'}
        onClose={() => setActiveModal(null)}
        footer={
          <>
            <Button
              variant="outline"
              tone="neutral"
              onClick={() => setActiveModal(null)}
            >
              Cancel
            </Button>
            <Button variant="solid" tone="info" onClick={handleLinkSubmit}>
              Confirm
            </Button>
          </>
        }
      >
        <div className="mt-4 flex flex-col gap-0">
          <textarea
            className="border-edge-default placeholder:text-border focus:border-info focus:ring-info min-h-25 w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm focus:outline-none"
            placeholder={`https://example.com/image.png\nhttps://example.com/doc.pdf\nhttps://google.com`}
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                handleLinkSubmit();
              }
            }}
          />
        </div>
      </Modal>
    </>
  );
};
