import clsx from 'clsx';
import {
  Lasso,
  MousePointer2,
  Hand,
  UploadCloud,
  Link as LinkIcon,
  ChevronDown,
  Undo2,
  Redo2,
  Sprout,
} from 'lucide-react';
import { useMemo, useRef, useState, type ChangeEvent } from 'react';

import { uploadImage, uploadPdf, uploadVideo } from '@/api/artifact';
import { useIsNotMouse } from '@/hooks/useInputMode';
import { useIntentStore } from '@/store/intentStore';
import { useToolStore } from '@/store/toolStore';

import { NODE_ICON } from '../../../config/nodeIcons.ts';
import useCanvasStore from '../../../store/canvasStore.ts';
import { detectNodeType } from '../../../utils/io/media.ts';
import { Button } from '../../Common/Button.tsx';
import { Modal } from '../../Common/Modal.tsx';
import { Popover } from '../../Common/Popover.tsx';
import {
  SplitSelect,
  type SplitSelectOption,
} from '../../Common/SplitSelect.tsx';
import { SketchSettingsPanel } from '../../Nodes/sketch/SketchSettingsPanel.tsx';

import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent';

interface NodeToolbarProps {
  activeTool: 'select' | 'pan' | 'lasso';
  onToolChange: (tool: 'select' | 'pan' | 'lasso') => void;
}

export const NodeToolbar = ({ activeTool, onToolChange }: NodeToolbarProps) => {
  const addNodes = useCanvasStore((s) => s.addNodes);
  const pendingNodeType = useToolStore((s) => s.pendingNodeType);
  const setPendingNodeType = useToolStore((s) => s.setPendingNodeType);
  const setSketchDraft = useToolStore((s) => s.setSketchDraft);

  // Non-mouse undo / redo (delete now lives on the per-context floating toolbars)
  const isNotMouse = useIsNotMouse();
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);
  const canvasId = useCanvasStore((s) => s.canvasId);

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const intentButtonRef = useRef<HTMLDivElement>(null);

  const intentOpen = useIntentStore((s) => s.isOpen);

  // State
  const [activeModal, setActiveModal] = useState<'upload' | 'link' | null>(
    null,
  );
  const [resourceMenuOpen, setResourceMenuOpen] = useState(false);
  const resourceMenuRef = useRef<HTMLDivElement>(null);
  const resourceJustDismissedRef = useRef(false);
  const [linkText, setLinkText] = useState('');

  // Selection / pan tool options for the merged dropdown trigger.
  const toolOptions = useMemo<SplitSelectOption<'select' | 'pan' | 'lasso'>[]>(
    () => [
      { value: 'select', label: 'Select', icon: <MousePointer2 /> },
      { value: 'pan', label: 'Pan', icon: <Hand /> },
      { value: 'lasso', label: 'Lasso', icon: <Lasso /> },
    ],
    [],
  );

  const resourceOptions: {
    value: 'upload' | 'link';
    label: string;
    icon: React.ReactNode;
  }[] = [
    { value: 'upload', label: 'Upload Files', icon: <UploadCloud /> },
    { value: 'link', label: 'Add Links', icon: <LinkIcon /> },
  ];

  const getResourceMenuPosition = () => {
    if (!resourceMenuRef.current) return { x: 0, y: 0 };
    const rect = resourceMenuRef.current.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  };

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
    if (!canvasId) return;
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
                uploadImage(file, canvasId),
                getImageDimensions(file),
              ]);
              url = uploadedUrl;
              naturalDimensions = dims;
            } else if (type === 'video') {
              const [uploadedUrl, dims] = await Promise.all([
                uploadVideo(file, canvasId),
                getVideoDimensions(file),
              ]);
              url = uploadedUrl;
              naturalDimensions = dims;
            } else if (type === 'pdf') {
              url = await uploadPdf(file, canvasId);
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
          <SplitSelect<'select' | 'pan' | 'lasso'>
            options={toolOptions}
            value={activeTool}
            onPrimaryAction={(tool) => {
              if (pendingNodeType) setPendingNodeType(null);
              onToolChange(tool);
            }}
            onChange={(t) => {
              if (pendingNodeType) setPendingNodeType(null);
              onToolChange(t);
            }}
            variant="ghost"
            tone="neutral"
            size="md"
            iconOnly
            align="top-left"
            primaryTitle={
              activeTool === 'select'
                ? 'Select'
                : activeTool === 'lasso'
                  ? 'Lasso'
                  : 'Pan'
            }
            menuTitle="More Tools"
            primaryButtonClassName={clsx(
              !pendingNodeType &&
                'text-info bg-bg-default enabled:hover:bg-bg-default',
            )}
            menuButtonClassName="enabled:hover:bg-bg-default"
          />
        </div>

        <div className="bg-edge-default mx-1 h-4 w-px" />

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
          <div className="relative flex items-center">
            {pendingNodeType === 'sketch' && <SketchSettingsPanel />}
            <Button
              variant="ghost"
              iconOnly
              title="Sketch"
              className={clsx(
                pendingNodeType === 'sketch' && 'text-info bg-bg-default',
              )}
              onClick={() => {
                // Clicking the Sketch button always resets the tool to draw
                // mode so the eraser doesn't silently persist between sessions.
                setSketchDraft({ mode: 'draw' });
                setPendingNodeType(
                  pendingNodeType === 'sketch' ? null : 'sketch',
                );
              }}
            >
              <NODE_ICON.sketch />
            </Button>
          </div>
        </div>

        <div ref={resourceMenuRef} className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            title="Upload or Link"
            className={clsx(resourceMenuOpen && 'bg-bg-default')}
            onClick={() => {
              if (resourceJustDismissedRef.current) return;
              setResourceMenuOpen((prev) => !prev);
            }}
          >
            <ChevronDown
              className={clsx(
                'transition-transform',
                resourceMenuOpen && 'rotate-180',
              )}
            />
          </Button>

          {resourceMenuOpen && (
            <Popover
              position={getResourceMenuPosition()}
              onDismiss={() => {
                resourceJustDismissedRef.current = true;
                setResourceMenuOpen(false);
                requestAnimationFrame(() => {
                  resourceJustDismissedRef.current = false;
                });
              }}
              anchor="bottom-left"
              offset={{ x: 0, y: -4 }}
              className="flex flex-col overflow-hidden py-1"
            >
              {resourceOptions.map((opt) => (
                <Button
                  key={opt.value}
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  role="menuitem"
                  className="w-full justify-start rounded-none px-3 py-1.5 text-left"
                  onClick={() => {
                    setResourceMenuOpen(false);
                    setActiveModal(opt.value);
                  }}
                >
                  <span className="shrink-0">{opt.icon}</span>
                  <span className="flex-1">{opt.label}</span>
                </Button>
              ))}
            </Popover>
          )}
        </div>

        <div className="bg-edge-default mx-1 h-4 w-px" />

        <div ref={intentButtonRef} className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            iconOnly
            title="Question Sticker"
            className={clsx(
              pendingNodeType === 'question' && 'text-info bg-bg-default',
            )}
            onClick={() =>
              setPendingNodeType(
                pendingNodeType === 'question' ? null : 'question',
              )
            }
          >
            <NODE_ICON.question />
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

        {/* Non-mouse only: Undo / Redo (Delete lives on the per-context floating toolbars) */}
        {isNotMouse && (
          <>
            <div className="bg-edge-default mx-1 h-4 w-px" />
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
            className="border-edge-default placeholder:text-fg-subtle focus:border-info focus:ring-info min-h-25 w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm focus:outline-none"
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
