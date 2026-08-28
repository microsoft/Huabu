// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  PanelsTopLeft,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';

import {
  uploadHtml,
  uploadImage,
  uploadOffice,
  uploadPdf,
  uploadVideo,
} from '@/api/artifact';
import { listCanvases } from '@/api/canvas';
import { matchesShortcut } from '@/config/shortcuts';
import { isEditableTarget } from '@/hooks/shortcuts';
import { useIsNotMouse } from '@/hooks/useInputMode';
import { useToolStore } from '@/store/toolStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import {
  getAvailableCanvasTools,
  resolveCanvasToolShortcut,
} from './canvasInputPolicy.ts';
import { NODE_ICON } from '../../../config/nodeIcons.ts';
import useCanvasStore from '../../../store/canvasStore.ts';
import { detectNodeType, detectOfficeFormat } from '../../../utils/io/media.ts';
import { Button } from '../../Common/Button.tsx';
import { Modal } from '../../Common/Modal.tsx';
import { Popover } from '../../Common/Popover.tsx';
import {
  SplitSelect,
  type SplitSelectOption,
} from '../../Common/SplitSelect.tsx';
import { SketchModeSwitcher } from '../../Nodes/sketch/SketchModeSwitcher.tsx';
import { SketchSettingsPanel } from '../../Nodes/sketch/SketchSettingsPanel.tsx';

import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent';
import type { CanvasSummary } from '@huabu/shared';

interface NodeToolbarProps {
  activeTool: 'select' | 'pan' | 'lasso';
  onToolChange: (tool: 'select' | 'pan' | 'lasso') => void;
}

export const NodeToolbar = ({ activeTool, onToolChange }: NodeToolbarProps) => {
  const { t } = useTranslation();
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
  const worldCanvasId = useWorkspaceStore((s) => s.worldCanvasId);
  const toolTitle = (label: string, shortcut: string) =>
    isNotMouse ? label : `${label} (${shortcut})`;

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const intentButtonRef = useRef<HTMLDivElement>(null);

  // State
  const [activeModal, setActiveModal] = useState<
    'upload' | 'link' | 'spacePreview' | null
  >(null);
  const [resourceMenuOpen, setResourceMenuOpen] = useState(false);
  const resourceMenuRef = useRef<HTMLDivElement>(null);
  const resourceJustDismissedRef = useRef(false);
  const [linkText, setLinkText] = useState('');
  const [previewTargets, setPreviewTargets] = useState<CanvasSummary[]>([]);
  const [previewTargetsLoading, setPreviewTargetsLoading] = useState(false);
  const [previewTargetsError, setPreviewTargetsError] = useState(false);

  // Select / Pan / Lasso live on a single SplitSelect: the primary button
  // mirrors the currently active tool and the popover lists every option
  // (with its letter shortcut hint).
  const toolOptions = useMemo<SplitSelectOption<'select' | 'pan' | 'lasso'>[]>(
    () =>
      getAvailableCanvasTools(isNotMouse).map((value) => ({
        value,
        label: t(`toolbar.tools.${value}`),
        icon:
          value === 'select' ? (
            <MousePointer2 />
          ) : value === 'pan' ? (
            <Hand />
          ) : (
            <Lasso />
          ),
        shortcut: isNotMouse
          ? undefined
          : value === 'select'
            ? 'S'
            : value === 'pan'
              ? 'P'
              : 'L',
      })),
    [isNotMouse, t],
  );

  const displayedTool = activeTool;
  const displayedToolActive = true;

  // Single-character keyboard shortcuts for the toolbar items, mirroring
  // the badge hints shown on each button. Select / Pan / Lasso get
  // dedicated letter keys (S / P / L) so each option is directly
  // addressable; node placement modes keep numeric keys. Intent is
  // intentionally omitted — it lives on its own bubble UI. Undo / Redo
  // are not bound here; mouse users have Ctrl/Cmd+Z and the floating
  // per-context toolbars cover non-mouse modes. Skipped while typing in
  // an editable target so the keys remain usable inside notes/text nodes.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isEditableTarget(e.target)) return;
      // Don't fire while a modal is open (file upload / add links).
      if (activeModal) return;

      // Keys sourced from the shared shortcut catalog. Tools (S/P/L) clear
      // any pending placement first; placement modes toggle themselves.
      if (matchesShortcut(e, 'tool.select')) {
        e.preventDefault();
        if (pendingNodeType) setPendingNodeType(null);
        onToolChange('select');
        return;
      }
      if (matchesShortcut(e, 'tool.pan')) {
        e.preventDefault();
        if (pendingNodeType) setPendingNodeType(null);
        onToolChange(resolveCanvasToolShortcut('pan', isNotMouse));
        return;
      }
      if (matchesShortcut(e, 'tool.lasso')) {
        e.preventDefault();
        if (pendingNodeType) setPendingNodeType(null);
        onToolChange('lasso');
        return;
      }
      if (matchesShortcut(e, 'mode.frame')) {
        e.preventDefault();
        onToolChange('select');
        setPendingNodeType(pendingNodeType === 'frame' ? null : 'frame');
        return;
      }
      if (matchesShortcut(e, 'mode.note')) {
        e.preventDefault();
        onToolChange('select');
        setPendingNodeType(pendingNodeType === 'note' ? null : 'note');
        return;
      }
      if (matchesShortcut(e, 'mode.text')) {
        e.preventDefault();
        onToolChange('select');
        setPendingNodeType(pendingNodeType === 'text' ? null : 'text');
        return;
      }
      if (matchesShortcut(e, 'mode.sketch')) {
        e.preventDefault();
        // Match the click handler: always reset the sketch tool to draw
        // mode so the eraser doesn't silently persist between sessions.
        setSketchDraft({ mode: 'draw' });
        onToolChange('select');
        setPendingNodeType(pendingNodeType === 'sketch' ? null : 'sketch');
        return;
      }
      // Temporarily disabled because the audio node feature is not ready yet.
      // if (matchesShortcut(e, 'mode.audio')) {
      //   e.preventDefault();
      //   setPendingNodeType(pendingNodeType === 'audio' ? null : 'audio');
      //   return;
      // }
      if (matchesShortcut(e, 'mode.question')) {
        e.preventDefault();
        onToolChange('select');
        setPendingNodeType(pendingNodeType === 'question' ? null : 'question');
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeModal,
    isNotMouse,
    onToolChange,
    pendingNodeType,
    setPendingNodeType,
    setSketchDraft,
  ]);

  const resourceOptions = useMemo<
    {
      value: 'upload' | 'link' | 'spacePreview';
      label: string;
      icon: React.ReactNode;
    }[]
  >(
    () => [
      {
        value: 'upload',
        label: t('toolbar.resources.uploadFiles'),
        icon: <UploadCloud />,
      },
      {
        value: 'link',
        label: t('toolbar.resources.addLinks'),
        icon: <LinkIcon />,
      },
      ...(canvasId !== worldCanvasId
        ? [
            {
              value: 'spacePreview' as const,
              label: t('spacePreview.add'),
              icon: <PanelsTopLeft />,
            },
          ]
        : []),
    ],
    [canvasId, t, worldCanvasId],
  );

  const openSpacePreviewModal = () => {
    setActiveModal('spacePreview');
    setPreviewTargetsLoading(true);
    setPreviewTargetsError(false);
    void listCanvases()
      .then(({ canvases }) =>
        setPreviewTargets(
          canvases.filter((canvas) => canvas.canvasId !== canvasId),
        ),
      )
      .catch(() => {
        setPreviewTargets([]);
        setPreviewTargetsError(true);
      })
      .finally(() => setPreviewTargetsLoading(false));
  };

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
            } else if (type === 'office') {
              url = await uploadOffice(file, canvasId);
              const format = detectOfficeFormat(file.name) ?? 'docx';
              return {
                nodeType: 'office',
                data: {
                  type: 'office',
                  src: url,
                  format,
                  label: file.name,
                  origin: { type: 'user-uploaded' },
                },
              };
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
            } else if (type === 'web') {
              // Local .html / .htm file — store the bytes as an
              // artifact (same path as drag/drop) so the preprocess
              // pipeline can render it as a Web node.
              url = await uploadHtml(file, canvasId);
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
      const detected = detectNodeType(finalUrl);
      // Remote office docs aren't downloaded; fall back to web so the
      // page (or its hosted preview) gets fetched instead.
      const type = detected === 'office' ? 'web' : detected;

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
            value={displayedTool}
            onPrimaryAction={(tool) => {
              if (pendingNodeType) setPendingNodeType(null);
              onToolChange(
                isNotMouse && tool === 'lasso' && activeTool === 'lasso'
                  ? 'select'
                  : tool,
              );
            }}
            onChange={(tool) => {
              if (pendingNodeType) setPendingNodeType(null);
              onToolChange(tool);
            }}
            variant="ghost"
            tone="neutral"
            size="md"
            iconOnly
            align="top-left"
            hideMenuButton={toolOptions.length === 1}
            primaryTitle={
              displayedTool === 'lasso'
                ? toolTitle(t('toolbar.tools.lasso'), 'L')
                : displayedTool === 'pan'
                  ? toolTitle(t('toolbar.tools.pan'), 'P')
                  : toolTitle(t('toolbar.tools.select'), 'S')
            }
            menuTitle={t('toolbar.tools.moreTools')}
            primaryShortcutBadge={
              isNotMouse
                ? undefined
                : activeTool === 'lasso'
                  ? 'L'
                  : activeTool === 'pan'
                    ? 'P'
                    : 'S'
            }
            primaryShortcutBadgeActive={!pendingNodeType}
            primaryButtonClassName={clsx(
              !pendingNodeType &&
                displayedToolActive &&
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
            title={toolTitle(t('toolbar.nodes.note'), '1')}
            shortcutBadge={isNotMouse ? undefined : '1'}
            shortcutBadgeActive={pendingNodeType === 'note'}
            className={clsx(
              pendingNodeType === 'note' && 'text-info bg-bg-default',
            )}
            onClick={() => {
              onToolChange('select');
              setPendingNodeType(pendingNodeType === 'note' ? null : 'note');
            }}
          >
            <NODE_ICON.note />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            title={toolTitle(t('toolbar.nodes.text'), '2')}
            shortcutBadge={isNotMouse ? undefined : '2'}
            shortcutBadgeActive={pendingNodeType === 'text'}
            className={clsx(
              pendingNodeType === 'text' && 'text-info bg-bg-default',
            )}
            onClick={() => {
              onToolChange('select');
              setPendingNodeType(pendingNodeType === 'text' ? null : 'text');
            }}
          >
            <NODE_ICON.text />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            title={toolTitle(t('toolbar.nodes.frame'), '3')}
            shortcutBadge={isNotMouse ? undefined : '3'}
            shortcutBadgeActive={pendingNodeType === 'frame'}
            className={clsx(
              pendingNodeType === 'frame' && 'text-info bg-bg-default',
            )}
            onClick={() => {
              onToolChange('select');
              setPendingNodeType(pendingNodeType === 'frame' ? null : 'frame');
            }}
          >
            <NODE_ICON.frame />
          </Button>
          <div className="relative flex items-center">
            {pendingNodeType === 'sketch' && (
              <SketchSettingsPanel
                touch={isNotMouse}
                showModeSwitcher={!isNotMouse}
              />
            )}
            {isNotMouse ? (
              <SketchModeSwitcher
                size="md"
                active={pendingNodeType === 'sketch'}
                onActivate={() => {
                  onToolChange('select');
                  setPendingNodeType('sketch');
                }}
              />
            ) : (
              <Button
                variant="ghost"
                iconOnly
                title={`${t('toolbar.nodes.sketch')} (4)`}
                shortcutBadge="4"
                shortcutBadgeActive={pendingNodeType === 'sketch'}
                className={clsx(
                  pendingNodeType === 'sketch' && 'text-info bg-bg-default',
                )}
                onClick={() => {
                  // Clicking the Sketch button always resets the tool to draw
                  // mode so the eraser doesn't silently persist between sessions.
                  setSketchDraft({ mode: 'draw' });
                  onToolChange('select');
                  setPendingNodeType(
                    pendingNodeType === 'sketch' ? null : 'sketch',
                  );
                }}
              >
                <NODE_ICON.sketch />
              </Button>
            )}
          </div>
          {/* Temporarily disabled because the audio node feature is not ready yet.
          <Button
            variant="ghost"
            iconOnly
            title={`${t('toolbar.nodes.audio')} (5)`}
            shortcutBadge="5"
            shortcutBadgeActive={pendingNodeType === 'audio'}
            className={clsx(
              pendingNodeType === 'audio' && 'text-info bg-bg-default',
            )}
            onClick={() =>
              setPendingNodeType(pendingNodeType === 'audio' ? null : 'audio')
            }
          >
            <NODE_ICON.audio />
          </Button> */}
        </div>

        <div ref={resourceMenuRef} className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            title={t('toolbar.resources.addContent')}
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
              offset={{ x: 0, y: -8 }}
              className="flex flex-col overflow-hidden py-1"
            >
              {resourceOptions.map((opt) => (
                <Button
                  key={opt.value}
                  variant="ghost"
                  tone="neutral"
                  size="md"
                  role="menuitem"
                  className="w-full justify-start rounded-none px-3 py-1.5 text-left"
                  onClick={() => {
                    setResourceMenuOpen(false);
                    if (opt.value === 'spacePreview') {
                      openSpacePreviewModal();
                    } else {
                      setActiveModal(opt.value);
                    }
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
            title={toolTitle(t('toolbar.nodes.agent'), 'A')}
            shortcutBadge={isNotMouse ? undefined : 'A'}
            shortcutBadgeActive={pendingNodeType === 'question'}
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
        </div>

        {/* Non-mouse only: Undo / Redo (Delete lives on the per-context floating toolbars) */}
        {isNotMouse && (
          <>
            <div className="bg-edge-default mx-1 h-4 w-px" />
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                iconOnly
                title={t('actions.undo')}
                disabled={!canUndo}
                onClick={() => undo()}
              >
                <Undo2 />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                title={t('actions.redo')}
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
        title={t('toolbar.resources.uploadTitle')}
        description={t('toolbar.resources.uploadDescription')}
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
            <span className="text-sm">
              {t('toolbar.resources.selectFiles')}
            </span>
          </Button>

          {/* Hidden Input for Multiple Selection */}
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            multiple
            accept="image/*,application/pdf,video/mp4,.md,.markdown,text/markdown,.docx,.xlsx,.pptx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,.html,.htm,text/html"
            onChange={handleFileChange}
          />
        </div>
      </Modal>

      <Modal
        title={t('spacePreview.chooseTarget')}
        description={t('spacePreview.chooseTargetDescription')}
        isOpen={activeModal === 'spacePreview'}
        onClose={() => setActiveModal(null)}
      >
        <div className="flex max-h-80 flex-col overflow-y-auto">
          {previewTargetsLoading ? (
            <div className="text-fg-muted p-4 text-center text-sm">
              {t('spacePreview.loadingTargets')}
            </div>
          ) : previewTargetsError ? (
            <div className="text-danger p-4 text-center text-sm">
              {t('spacePreview.targetsUnavailable')}
            </div>
          ) : previewTargets.length === 0 ? (
            <div className="text-fg-muted p-4 text-center text-sm">
              {t('spacePreview.noTargets')}
            </div>
          ) : (
            previewTargets.map((target) => (
              <Button
                key={target.canvasId}
                variant="ghost"
                size="md"
                className="w-full justify-start rounded-none"
                onClick={() => {
                  addNodes([
                    {
                      nodeType: 'spacePreview',
                      data: {
                        targetCanvasId: target.canvasId,
                        origin: { type: 'user-created' },
                      },
                    },
                  ]);
                  setActiveModal(null);
                }}
              >
                <PanelsTopLeft />
                <span className="min-w-0 truncate">
                  {target.title || t('spacePreview.untitledSpace')}
                </span>
              </Button>
            ))
          )}
        </div>
      </Modal>

      {/* 2. Link Input Modal */}
      <Modal
        title={t('toolbar.resources.addLinks')}
        description={t('toolbar.resources.linkDescription')}
        isOpen={activeModal === 'link'}
        onClose={() => setActiveModal(null)}
        footer={
          <>
            <Button
              variant="outline"
              tone="neutral"
              onClick={() => setActiveModal(null)}
            >
              {t('actions.cancel')}
            </Button>
            <Button variant="solid" tone="info" onClick={handleLinkSubmit}>
              {t('actions.confirm')}
            </Button>
          </>
        }
      >
        <div className="mt-4 flex flex-col gap-0">
          <textarea
            name="resource-urls"
            autoComplete="off"
            aria-label={t('toolbar.resources.linkDescription')}
            className="border-edge-default placeholder:text-fg-subtle focus:border-info focus:ring-info min-h-25 w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm focus:outline-none"
            placeholder={`https://example.com/image.png\nhttps://example.com/doc.pdf\nhttps://google.com`}
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
            // Modal opens solely to collect this input.
            // eslint-disable-next-line jsx-a11y/no-autofocus
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
