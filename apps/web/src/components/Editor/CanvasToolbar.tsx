import clsx from 'clsx';
import {
  MousePointer2,
  Hand,
  LayoutDashboard,
  UploadCloud,
  Link as LinkIcon,
  Sprout,
  Sparkles,
} from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';

import { uploadImage, uploadPdf, uploadVideo } from '../../api/artifact.ts';
import { NODE_ICON } from '../../config/nodeIcons.ts';
import useCanvasStore from '../../store/canvasStore.ts';
import { useIntentStore } from '../../store/intentStore.ts';
import { detectNodeType } from '../../utils/io/media.ts';
import { Button } from '../Common/Button';
import { IconButton } from '../Common/IconButton';
import { Modal } from '../Common/Modal';

import type { AddNodeInput } from '../../canvas/uiIntent.ts';

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
      <div className="text-muted-foreground shadow-bottom bg-card pointer-events-auto relative flex w-max items-center gap-2 rounded-lg border-0 px-4 py-2">
        {/* Group 1: Tools */}
        <div className="flex items-center gap-2">
          <IconButton
            title="Select"
            className={clsx(
              activeTool === 'select' && 'text-info bg-background',
            )}
            onClick={() => onToolChange('select')}
          >
            <MousePointer2 size={18} />
          </IconButton>
          <IconButton
            title="Pan"
            className={clsx(activeTool === 'pan' && 'text-info bg-background')}
            onClick={() => onToolChange('pan')}
          >
            <Hand size={18} />
          </IconButton>
        </div>

        <div className="bg-border mx-1 h-4 w-px" />

        {/* Group 2: Nodes */}
        <div className="flex items-center gap-2">
          <IconButton
            title="Frame"
            className={clsx(
              pendingNodeType === 'frame' && 'text-info bg-background',
            )}
            onClick={() =>
              setPendingNodeType(pendingNodeType === 'frame' ? null : 'frame')
            }
          >
            <NODE_ICON.frame size={18} />
          </IconButton>
          <IconButton
            title="Note"
            className={clsx(
              pendingNodeType === 'note' && 'text-info bg-background',
            )}
            onClick={() =>
              setPendingNodeType(pendingNodeType === 'note' ? null : 'note')
            }
          >
            <NODE_ICON.note size={18} />
          </IconButton>
          <IconButton
            title="Text"
            className={clsx(
              pendingNodeType === 'text' && 'text-info bg-background',
            )}
            onClick={() =>
              setPendingNodeType(pendingNodeType === 'text' ? null : 'text')
            }
          >
            <NODE_ICON.text size={18} />
          </IconButton>
        </div>

        <div className="bg-border mx-1 h-4 w-px" />

        <div className="flex items-center gap-2">
          <IconButton
            title="Upload Files"
            className={clsx(
              activeModal === 'upload' && 'text-info bg-background',
            )}
            onClick={() => setActiveModal('upload')}
          >
            <UploadCloud size={18} />
          </IconButton>

          <IconButton
            title="Add Links"
            className={clsx(
              activeModal === 'link' && 'text-info bg-background',
            )}
            onClick={() => setActiveModal('link')}
          >
            <LinkIcon size={18} />
          </IconButton>
        </div>

        <div className="bg-border mx-1 h-4 w-px" />

        <div className="flex items-center gap-2">
          <IconButton title="Auto Layout All" onClick={() => layoutAll()}>
            <LayoutDashboard size={18} />
          </IconButton>
          <IconButton
            title={
              autoLayoutEnabled ? 'Disable Auto Layout' : 'Enable Auto Layout'
            }
            onClick={() => toggleAutoLayout()}
            className={clsx(autoLayoutEnabled && 'text-info bg-background')}
          >
            <Sparkles size={18} />
          </IconButton>
        </div>

        <div className="bg-border mx-1 h-4 w-px" />

        <div ref={intentButtonRef} className="flex items-center gap-2">
          <IconButton
            title="Intent (crtl + I)"
            className={clsx(intentOpen && 'text-info bg-background')}
            onClick={() => {
              const rect = intentButtonRef.current?.getBoundingClientRect();
              if (rect) {
                useIntentStore
                  .getState()
                  .triggerIntent(rect.left + rect.width / 2, rect.top);
              }
            }}
          >
            <Sprout size={18} />
          </IconButton>
        </div>
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
          <button
            onClick={() => fileInputRef.current?.click()}
            className="bg-info-bg hover:bg-info-bg-hover text-info border-info flex w-full flex-col items-center gap-2 rounded-md border border-dashed px-4 py-8 transition-colors"
          >
            <UploadCloud size={24} />
            <span className="text-sm">Click to select files</span>
          </button>

          {/* Hidden Input for Multiple Selection */}
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            multiple
            accept="image/*,application/pdf,video/mp4"
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
            <Button variant="secondary" onClick={() => setActiveModal(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleLinkSubmit}>
              Confirm
            </Button>
          </>
        }
      >
        <div className="mt-4 flex flex-col gap-0">
          <textarea
            className="border-border placeholder:text-border focus:border-info focus:ring-info min-h-25 w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm focus:outline-none"
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
