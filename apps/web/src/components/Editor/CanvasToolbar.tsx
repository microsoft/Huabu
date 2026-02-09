import { createId } from '@sediment/shared';
import { useReactFlow } from '@xyflow/react';
import clsx from 'clsx';
import {
  MousePointer2,
  Hand,
  Scan,
  StickyNote,
  Type,
  Image as ImageIcon,
  FileText,
  PlaySquare,
  Globe,
  LayoutGrid,
  Check,
  X,
  UploadCloud,
  Link as LinkIcon,
} from 'lucide-react';
import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  useEffect,
} from 'react';

import { GhostButton } from '../Common/GhostButton';

const UrlInputPopover = ({
  type,
  onConfirm,
  onCancel,
  onUploadClick,
}: {
  type: 'pdf' | 'web' | 'video' | 'image';
  onConfirm: (url: string) => void;
  onCancel: () => void;
  onUploadClick?: () => void;
}) => {
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onConfirm(url);
    if (e.key === 'Escape') onCancel();
  };

  return (
    <div className="shadow-border border-border animate-in fade-in zoom-in-95 absolute bottom-full left-1/2 z-50 mb-3 flex min-w-[260px] -translate-x-1/2 items-center gap-1 rounded-lg border bg-white px-2 py-1 duration-100">
      <div className="text-muted-foreground absolute -bottom-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-r border-b border-gray-200 bg-white" />
      <div className="pl-1">
        <LinkIcon size={14} />
      </div>

      <input
        ref={inputRef}
        className="min-w-0 flex-1 border-none bg-transparent px-2 text-xs text-gray-700 placeholder:text-gray-400 focus:ring-0 focus:outline-none"
        placeholder={type === 'web' ? 'https://example.com' : 'URL...'}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {onUploadClick && (
        <>
          <div className="bg-border mx-1 h-4 w-px" />
          <button
            onClick={onUploadClick}
            className="hover:text-theme-500 hover:bg-theme-50 rounded p-1 transition-colors"
            title="Upload Local File"
          >
            <UploadCloud size={14} />
          </button>
        </>
      )}

      <div className="bg-border mx-1 h-4 w-px" />

      <button
        onClick={() => onConfirm(url)}
        disabled={!url}
        className="text-theme-500 hover:bg-theme-50 rounded p-1 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <Check size={14} />
      </button>

      <button
        onClick={onCancel}
        className="text-main hover:text-danger hover:bg-danger-bg rounded p-1 transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
};

interface NodeToolbarProps {
  activeTool: 'select' | 'pan';
  onToolChange: (tool: 'select' | 'pan') => void;
}

export const NodeToolbar = ({ activeTool, onToolChange }: NodeToolbarProps) => {
  const { addNodes, screenToFlowPosition } = useReactFlow();

  // Refs for file inputs
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const [activePopup, setActivePopup] = useState<
    'image' | 'pdf' | 'web' | 'video' | null
  >(null);

  const createNode = useCallback(
    (type: string, payload?: any) => {
      const position = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });

      const offset = Math.random() * 30 - 15;

      const newNode: any = {
        id: createId(type),
        type,
        position: { x: position.x + offset, y: position.y + offset },
        data: {},
        style: {},
      };

      switch (type) {
        case 'note':
          newNode.data = { content: '' };
          newNode.style = { width: 400, height: 300 };
          break;
        case 'text':
          newNode.data = { content: 'Double click to edit text' };
          break;
        case 'image':
          newNode.data = { src: payload?.src || '', alt: 'Image' };
          break;
        case 'pdf':
          newNode.data = { src: payload?.src || '', title: 'PDF Document' };
          newNode.style = { width: 400, height: 500 };
          break;
        case 'video':
          newNode.data = { src: payload?.src, title: 'Video' };
          break;
        case 'web':
          newNode.data = { src: payload?.src || '', title: 'Web' };
          newNode.style = { width: 400, height: 300 };
          break;
        case 'frame':
          newNode.style = {
            width: 600,
            height: 400,
            backgroundColor: 'rgba(0,0,0,0.05)',
          };
          newNode.data = { label: 'New Frame' };
          break;
        default:
          return;
      }

      addNodes(newNode);
      setActivePopup(null);
      console.log(newNode);
    },
    [addNodes, screenToFlowPosition],
  );

  const onImageChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      createNode('image', { src: url });
      e.target.value = ''; // Reset
    }
  };
  const onPdfFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      createNode('pdf', { src: url });
      e.target.value = ''; // Reset
    }
  };
  const onVideoChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      createNode('video', { src: url });
      e.target.value = ''; // Reset
    }
  };
  const handleUrlConfirm = (url: string) => {
    if (!url) return;
    if (activePopup === 'web') {
      const finalUrl = url.startsWith('http') ? url : `https://${url}`;
      createNode('web', { src: finalUrl });
    } else if (activePopup === 'pdf') {
      createNode('pdf', { src: url });
    } else if (activePopup === 'video') {
      createNode('video', { src: url });
    } else if (activePopup === 'image') {
      createNode('image', { src: url });
    }
  };

  return (
    <div className="text-muted-foreground shadow-bottom pointer-events-auto relative flex w-max items-center gap-2 rounded-lg border-0 bg-white p-2">
      {/* --- Hidden Inputs --- */}
      <input
        type="file"
        ref={imageInputRef}
        className="hidden"
        accept="image/*"
        onChange={onImageChange}
      />
      <input
        type="file"
        ref={pdfInputRef}
        className="hidden"
        accept="application/pdf"
        onChange={onPdfFileChange}
      />
      <input
        type="file"
        ref={videoInputRef}
        className="hidden"
        accept="video/mp4"
        onChange={onVideoChange}
      />

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
      </div>

      <div className="bg-border mx-1 h-4 w-px" />

      {/* Group 3: Media (Complex interactions here) */}
      <div className="flex items-center gap-2">
        <GhostButton title="Text" onClick={() => createNode('text')}>
          <Type size={18} />
        </GhostButton>

        <div className="relative">
          <GhostButton
            title="Image"
            className={clsx(
              activePopup === 'image' && 'text-theme-500 bg-background',
            )}
            onClick={() =>
              setActivePopup(activePopup === 'image' ? null : 'image')
            }
          >
            <ImageIcon size={18} />
          </GhostButton>
          {activePopup === 'image' && (
            <UrlInputPopover
              type="image"
              onConfirm={handleUrlConfirm}
              onCancel={() => setActivePopup(null)}
              onUploadClick={() => imageInputRef.current?.click()}
            />
          )}
        </div>

        <div className="relative">
          <GhostButton
            title="PDF"
            className={clsx(
              activePopup === 'pdf' && 'text-theme-500 bg-background',
            )}
            onClick={() => setActivePopup(activePopup === 'pdf' ? null : 'pdf')}
          >
            <FileText size={18} />
          </GhostButton>
          {activePopup === 'pdf' && (
            <UrlInputPopover
              type="pdf"
              onConfirm={handleUrlConfirm}
              onCancel={() => setActivePopup(null)}
              onUploadClick={() => pdfInputRef.current?.click()}
            />
          )}
        </div>

        <div className="relative">
          <GhostButton
            title="Video"
            className={clsx(
              activePopup === 'video' && 'text-theme-500 bg-background',
            )}
            onClick={() =>
              setActivePopup(activePopup === 'video' ? null : 'video')
            }
          >
            <PlaySquare size={18} />
          </GhostButton>
          {activePopup === 'video' && (
            <UrlInputPopover
              type="video"
              onConfirm={handleUrlConfirm}
              onCancel={() => setActivePopup(null)}
              onUploadClick={() => videoInputRef.current?.click()}
            />
          )}
        </div>

        <div className="relative">
          <GhostButton
            title="Website"
            className={clsx(
              activePopup === 'web' && 'text-theme-500 bg-background',
            )}
            onClick={() => setActivePopup(activePopup === 'web' ? null : 'web')}
          >
            <Globe size={18} />
          </GhostButton>
          {activePopup === 'web' && (
            <UrlInputPopover
              type="web"
              onConfirm={handleUrlConfirm}
              onCancel={() => setActivePopup(null)}
            />
          )}
        </div>
      </div>

      <div className="bg-border mx-1 h-4 w-px" />

      <div className="flex items-center gap-2">
        <GhostButton title="Layout">
          <LayoutGrid size={18} />
        </GhostButton>
      </div>
    </div>
  );
};
