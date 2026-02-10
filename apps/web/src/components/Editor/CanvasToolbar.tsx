import { createId } from '@sediment/shared';
import { useReactFlow } from '@xyflow/react';
import clsx from 'clsx';
import {
  MousePointer2,
  Hand,
  Scan,
  StickyNote,
  Type,
  LayoutGrid,
  UploadCloud,
  Link as LinkIcon,
  X,
} from 'lucide-react';
import { useCallback, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';

import { uploadImage, uploadPdf, uploadVideo } from '../../api/artifact.ts';
import useCanvasStore from '../../store/canvasStore.ts';
import { GhostButton } from '../Common/GhostButton';

import type {
  CanvasNode,
  CanvasNodeType,
  CreateNodePayload,
} from '../Nodes/types.ts';

const detectNodeType = (
  filename: string,
): 'image' | 'pdf' | 'video' | 'web' => {
  const ext = filename.split('.').pop()?.toLowerCase();

  if (!ext) return 'web';

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
  const videoExts = ['mp4', 'webm', 'ogg', 'mov'];

  if (imageExts.includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (videoExts.includes(ext)) return 'video';

  return 'web';
};

interface UploadModalProps {
  title: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirm?: () => void;
  children: React.ReactNode;
  showConfirm?: boolean;
}

const UploadModal = ({
  title,
  isOpen,
  onClose,
  onConfirm,
  children,
  showConfirm = false,
}: UploadModalProps) => {
  if (!isOpen) return null;

  return createPortal(
    <div className="bg-background/80 animate-in fade-in fixed inset-0 z-9999 flex items-center justify-center backdrop-blur-[1px] duration-200">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="border-border shadow-bottom animate-in zoom-in-95 relative z-10 w-90 rounded-lg border bg-white p-6 duration-200">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-main text-sm font-semibold">{title}</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-danger rounded p-1 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div>{children}</div>

        {showConfirm && (
          <div className="mt-4 flex justify-center gap-4">
            <button
              onClick={onClose}
              className="text-danger bg-danger-bg flex items-center rounded px-2 py-1 text-xs transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="bg-theme-50 hover:bg-theme-100 text-theme-500 flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors"
            >
              {/*<Check size={12} />*/}
              Confirm
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

interface NodeToolbarProps {
  activeTool: 'select' | 'pan';
  onToolChange: (tool: 'select' | 'pan') => void;
}

export const NodeToolbar = ({ activeTool, onToolChange }: NodeToolbarProps) => {
  const { screenToFlowPosition } = useReactFlow();
  const addNode = useCanvasStore((s) => s.addNode);

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);

  // State
  const [activeModal, setActiveModal] = useState<'upload' | 'link' | null>(
    null,
  );
  const [linkText, setLinkText] = useState('');

  const createNode = useCallback(
    (type: CanvasNodeType, payload?: CreateNodePayload) => {
      const position = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });

      const offsetX = Math.random() * 100 - 50;
      const offsetY = Math.random() * 100 - 50;

      const initialWidth = payload?.width || 400;
      const initialHeight = payload?.height || 300;

      const newNode: CanvasNode = {
        id: createId('node'),
        type,
        position: { x: position.x + offsetX, y: position.y + offsetY },
        data: {},
        style: {},
      };

      switch (type) {
        case 'note':
          newNode.data = { content: '' };
          newNode.style = { width: initialWidth, height: initialHeight };
          break;
        case 'text':
          newNode.data = { content: '' };
          newNode.style = { width: initialWidth, height: initialHeight };
          break;
        case 'image':
          newNode.data = {
            src: payload?.src || '',
          };
          break;
        case 'pdf':
          newNode.data = {
            src: payload?.src || '',
          };
          newNode.style = { width: initialWidth, height: initialHeight };
          newNode.isExpanded = true;
          break;
        case 'video':
          newNode.data = {
            src: payload?.src,
          };
          break;
        case 'web':
          newNode.data = {
            src: payload?.src || '',
          };
          newNode.style = { width: initialWidth, height: initialHeight };
          break;
        case 'frame':
          newNode.style = {
            width: initialWidth,
            height: initialHeight,
            backgroundColor: 'rgba(0,0,0,0.05)',
          };
          newNode.data = { label: 'New Frame' };
          break;
        default:
          return;
      }

      addNode(newNode);
    },
    [addNode, screenToFlowPosition],
  );

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

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const type = detectNodeType(file.name);

      try {
        let url = '';
        let dimensions = { width: 400, height: 300 };

        if (type === 'image') {
          const [uploadedUrl, dims] = await Promise.all([
            uploadImage(file),
            getImageDimensions(file),
          ]);
          url = uploadedUrl;
          dimensions = dims;
        } else if (type === 'video') {
          const [uploadedUrl, dims] = await Promise.all([
            uploadVideo(file),
            getVideoDimensions(file),
          ]);
          url = uploadedUrl;
          dimensions = dims;
        } else if (type === 'pdf') {
          url = await uploadPdf(file);
          dimensions = { width: 400, height: 300 };
        }

        createNode(type, {
          src: url,
          label: file.name,
          ...dimensions,
        });
      } catch (error) {
        console.error(`Failed to upload ${file.name}:`, error);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleLinkSubmit = () => {
    if (!linkText.trim()) return;

    const lines = linkText.split('\n');

    lines.forEach((line) => {
      const url = line.trim();
      if (!url) return;

      const finalUrl = url.startsWith('http') ? url : `https://${url}`;
      const type = detectNodeType(finalUrl);

      createNode(type, {
        src: finalUrl,
      });
    });

    setLinkText('');
    setActiveModal(null);
  };

  return (
    <>
      <div className="text-muted-foreground shadow-bottom pointer-events-auto relative flex w-max items-center gap-2 rounded-lg border-0 bg-white p-2">
        {/* Group 1: Tools */}
        <div className="flex items-center gap-2">
          <GhostButton
            title="Select"
            className={clsx(
              activeTool === 'select' && 'text-theme-500 bg-background',
            )}
            onClick={() => onToolChange('select')}
          >
            <MousePointer2 size={18} />
          </GhostButton>
          <GhostButton
            title="Pan"
            className={clsx(
              activeTool === 'pan' && 'text-theme-500 bg-background',
            )}
            onClick={() => onToolChange('pan')}
          >
            <Hand size={18} />
          </GhostButton>
        </div>

        <div className="bg-border mx-1 h-4 w-px" />

        {/* Group 2: Layouts */}
        <div className="flex items-center gap-2">
          <GhostButton title="Frame" onClick={() => createNode('frame')}>
            <Scan size={18} />
          </GhostButton>
          <GhostButton title="Note" onClick={() => createNode('note')}>
            <StickyNote size={18} />
          </GhostButton>
          <GhostButton title="Text" onClick={() => createNode('text')}>
            <Type size={18} />
          </GhostButton>
        </div>

        <div className="bg-border mx-1 h-4 w-px" />

        <div className="flex items-center gap-2">
          <GhostButton
            title="Upload Files"
            className={clsx(
              activeModal === 'upload' && 'text-theme-500 bg-background',
            )}
            onClick={() => setActiveModal('upload')}
          >
            <UploadCloud size={18} />
          </GhostButton>

          <GhostButton
            title="Add Links"
            className={clsx(
              activeModal === 'link' && 'text-theme-500 bg-background',
            )}
            onClick={() => setActiveModal('link')}
          >
            <LinkIcon size={18} />
          </GhostButton>
        </div>

        <div className="bg-border mx-1 h-4 w-px" />

        <div className="flex items-center gap-2">
          <GhostButton title="Layout">
            <LayoutGrid size={18} />
          </GhostButton>
        </div>
      </div>

      {/* --- Modals --- */}

      {/* 1. File Upload Modal */}
      <UploadModal
        title="Upload Local Files"
        isOpen={activeModal === 'upload'}
        onClose={() => setActiveModal(null)}
      >
        <div className="flex flex-col items-center justify-center gap-4 pt-2">
          <p className="text-muted-foreground text-center text-xs">
            Supports Images, PDFs, and Videos.
            <br />
            Select multiple files to upload in batch.
          </p>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="bg-theme-50 hover:bg-theme-100 text-theme-500 border-theme-500 flex w-full flex-col items-center gap-2 rounded-md border border-dashed px-4 py-8 transition-colors"
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
      </UploadModal>

      {/* 2. Link Input Modal */}
      <UploadModal
        title="Add Links"
        isOpen={activeModal === 'link'}
        onClose={() => setActiveModal(null)}
        onConfirm={handleLinkSubmit}
        showConfirm={true}
      >
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-xs">
            Paste URLs below (one per line).
          </p>
          <textarea
            className="border-border placeholder:text-border focus:border-theme-500 focus:ring-theme-500 min-h-25 w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm focus:outline-none"
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
      </UploadModal>
    </>
  );
};
