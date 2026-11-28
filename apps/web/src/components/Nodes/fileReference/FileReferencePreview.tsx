// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { isFileReference } from '@huabu/shared';

import { readDeviceFile } from '@/api/device-files';
import { Button } from '@/components/Common/Button';
import useCanvasStore, { selectCanWriteCanvas } from '@/store/canvasStore';
import {
  closePreviewFile,
  openFileReference,
} from '@/store/previewWorkspace/actions';
import { deviceFileName, isPdfDevicePath } from '@/utils/deviceFile';
import {
  downloadDeviceFile,
  formatDeviceDownloadError,
} from '@/utils/io/deviceFileDownload';

import { splitMarkdownFrontmatter } from './markdownFrontmatter';

import type { PreviewComponentProps } from '../previews';
import type { EditorView } from '@codemirror/view';
import type { FileReadResult } from '@huabu/shared';

const SourceViewer = lazy(
  () => import('@/components/CodeMirror/RawMarkdownEditor'),
);
const CommentActions = lazy(async () => ({
  default: (await import('./FileCommentActions')).FileCommentActions,
}));
const MarkdownViewer = lazy(async () => ({
  default: (await import('@/components/Milkdown/MilkdownPreview'))
    .MilkdownPreview,
}));
const DevicePdfViewer = lazy(() => import('./DevicePdfPreview'));
const MAX_PREVIEW_BYTES = 262_144;

export function FileReferencePreview({
  id,
  data,
  scrollViewKey,
}: PreviewComponentProps) {
  const { t } = useTranslation();
  const reference = isFileReference(data.fileReference)
    ? data.fileReference
    : null;
  const agentletId = reference?.agentletId;
  const path = reference?.path;
  const isPdf = path ? isPdfDevicePath(path) : false;
  const fileIdentity = `${agentletId ?? ''}\0${path ?? ''}`;
  const [loaded, setLoaded] = useState<{
    identity: string;
    result: FileReadResult;
  } | null>(null);
  const result = loaded?.identity === fileIdentity ? loaded.result : null;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const loadedBytes = useRef(0);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasId = useCanvasStore((state) => state.canvasId);
  const canWrite = useCanvasStore(selectCanWriteCanvas);
  const [view, setView] = useState<EditorView | null>(null);
  const [mode, setMode] = useState<'reading' | 'source'>('reading');
  const [renderError, setRenderError] = useState<string | null>(null);
  const frontmatterRegionId = useId();
  const [collapsedFileIdentity, setCollapsedFileIdentity] = useState<
    string | null
  >(null);
  const frontmatterExpanded = collapsedFileIdentity !== fileIdentity;
  const isMarkdown = /\.(?:md|markdown|mdown|mkd)$/i.test(path ?? '');
  const canReadMarkdown =
    isMarkdown && !!result && !result.nextCursor && !pending && !error;
  const reading = canReadMarkdown && mode === 'reading' && !renderError;
  const sourceText = result?.text;
  const parsedMarkdown = useMemo(
    () =>
      canReadMarkdown && sourceText !== undefined
        ? splitMarkdownFrontmatter(sourceText)
        : null,
    [canReadMarkdown, sourceText],
  );
  const frontmatter = parsedMarkdown?.frontmatter ?? null;
  const markdownBody = parsedMarkdown
    ? parsedMarkdown.body
    : (sourceText ?? '');
  const hasMarkdownBody =
    frontmatter === null || markdownBody.trim().length > 0;
  useEffect(() => {
    setMode('reading');
    downloadController.current?.abort();
    downloadController.current = null;
    setDownloading(false);
    return () => {
      downloadController.current?.abort();
      downloadController.current = null;
    };
  }, [agentletId, path]);
  useEffect(() => {
    const current = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    loadedBytes.current = 0;
    setLoaded(null);
    setError(null);
    setRenderError(null);
    if (!agentletId || !path || isPdf) return;
    setPending(true);
    void readDeviceFile(agentletId, { path }, abort.signal)
      .then((value) => {
        if (current !== generation.current) return;
        loadedBytes.current = value.byteLength;
        if (value.nextCursor) setMode('source');
        setLoaded({ identity: fileIdentity, result: value });
      })
      .catch((failure: unknown) => {
        if (current === generation.current && !abort.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : t('files.failed'),
          );
      })
      .finally(() => {
        if (current === generation.current) setPending(false);
      });
    return () => {
      generation.current = current + 1;
      abort.abort();
    };
  }, [agentletId, fileIdentity, isPdf, path, refresh, t]);

  const more = async () => {
    if (
      !result?.nextCursor ||
      !agentletId ||
      !path ||
      pending ||
      MAX_PREVIEW_BYTES - loadedBytes.current < 4
    )
      return;
    const current = generation.current;
    setPending(true);
    setError(null);
    try {
      const next = await readDeviceFile(
        agentletId,
        {
          path,
          cursor: result.nextCursor,
          limitBytes: Math.min(65_536, MAX_PREVIEW_BYTES - loadedBytes.current),
        },
        controller.current?.signal,
      );
      if (current !== generation.current) return;
      if (next.contentVersion !== result.contentVersion)
        throw new Error(t('files.changed'));
      loadedBytes.current += next.byteLength;
      setLoaded({
        identity: fileIdentity,
        result: { ...next, text: result.text + next.text },
      });
    } catch (failure) {
      if (current === generation.current)
        setError(
          failure instanceof Error ? failure.message : t('files.failed'),
        );
    } finally {
      if (current === generation.current) setPending(false);
    }
  };
  if (!reference)
    return (
      <div role="alert" className="text-danger p-4">
        {t('files.invalidReference')}
      </div>
    );
  if (isPdf) {
    return (
      <Suspense fallback={<div className="p-3">{t('files.loading')}</div>}>
        <DevicePdfViewer
          id={id}
          reference={reference}
          scrollViewKey={scrollViewKey}
        />
      </Suspense>
    );
  }
  return (
    <div ref={surfaceRef} className="flex h-full min-h-0 flex-col">
      {canvasId && agentletId ? (
        <Suspense fallback={null}>
          <CommentActions
            key={`${canvasId}\0${id ?? ''}\0${agentletId}\0${path}`}
            view={view}
            surfaceRef={surfaceRef}
            canvasId={canvasId}
            nodeId={id}
            agentletId={agentletId}
            file={result}
            disabled={pending || !!error || reading}
          />
        </Suspense>
      ) : null}
      <div className="border-edge-default flex shrink-0 flex-wrap items-center gap-2 border-b p-2 text-xs">
        <span className="text-fg-muted min-w-0 flex-1 break-all">
          {reference.deviceName ?? agentletId} · {path}
        </span>
        {id || !canWrite || !canvasId ? null : (
          // Opened straight from the file browser: nothing is in the Space yet.
          // Adding a reference hands this Preview over to the new node.
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              try {
                openFileReference(
                  canvasId,
                  reference,
                  deviceFileName(reference.path),
                );
                closePreviewFile(reference);
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : t('files.creationFailed'),
                );
              }
            }}
          >
            {t('files.addToSpace')}
          </Button>
        )}
        {isMarkdown ? (
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label={t('files.viewMode')}
          >
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={reading}
              disabled={!canReadMarkdown || !!renderError}
              onClick={() => setMode('reading')}
            >
              {t('files.reading')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={!reading}
              onClick={() => setMode('source')}
            >
              {t('files.source')}
            </Button>
          </div>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={downloading}
          onClick={() => {
            if (!agentletId || !path || downloading) return;
            downloadController.current?.abort();
            const abort = new AbortController();
            downloadController.current = abort;
            setDownloading(true);
            setError(null);
            void downloadDeviceFile(agentletId, path, { signal: abort.signal })
              .catch((failure: unknown) => {
                if (!abort.signal.aborted) {
                  setError(formatDeviceDownloadError(failure, t));
                }
              })
              .finally(() => {
                if (downloadController.current === abort) {
                  downloadController.current = null;
                  setDownloading(false);
                }
              });
          }}
        >
          {downloading ? t('files.downloading') : t('files.download')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {t('files.refresh')}
        </Button>
      </div>
      {isMarkdown ? (
        <p className="text-fg-muted px-3 py-2 text-xs">
          {result?.nextCursor
            ? t('files.partialMarkdown')
            : t('files.singleFileMarkdown')}
        </p>
      ) : null}
      {renderError ? (
        <div role="alert" className="text-danger p-3 text-xs">
          {t('files.renderFailed')} {renderError}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="text-danger p-3 text-xs">
          {error}
        </div>
      ) : null}
      {pending ? (
        <div role="status" className="text-fg-muted p-2 text-xs">
          {t('files.loading')}
        </div>
      ) : null}
      {result ? (
        <Suspense fallback={<div className="p-3">{t('files.loading')}</div>}>
          {reading ? (
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {frontmatter !== null ? (
                <section
                  aria-label={t('files.frontmatter')}
                  className={
                    hasMarkdownBody
                      ? 'border-edge-default bg-bg-default mb-4 overflow-hidden rounded-md border'
                      : 'border-edge-default bg-bg-default overflow-hidden rounded-md border'
                  }
                >
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={frontmatterExpanded}
                    aria-controls={
                      frontmatterExpanded ? frontmatterRegionId : undefined
                    }
                    onClick={() =>
                      setCollapsedFileIdentity((current) =>
                        current === fileIdentity ? null : fileIdentity,
                      )
                    }
                    className="text-fg-muted enabled:hover:text-fg-default w-full justify-start rounded-none px-3 py-1.5 text-left text-xs font-medium"
                  >
                    {frontmatterExpanded ? (
                      <ChevronDown aria-hidden="true" />
                    ) : (
                      <ChevronRight aria-hidden="true" />
                    )}
                    <span>{t('files.frontmatter')}</span>
                  </Button>
                  {frontmatterExpanded ? (
                    <div
                      id={frontmatterRegionId}
                      className="border-edge-default border-t px-3 py-2"
                    >
                      {frontmatter.trim().length > 0 ? (
                        <pre className="text-fg-default overflow-x-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
                          <code>{frontmatter}</code>
                        </pre>
                      ) : (
                        <p className="text-fg-subtle text-xs italic">
                          {t('files.emptyFrontmatter')}
                        </p>
                      )}
                    </div>
                  ) : null}
                </section>
              ) : null}
              {hasMarkdownBody ? (
                <MarkdownViewer
                  key={`${agentletId}:${path}:${refresh}`}
                  markdown={markdownBody}
                  singleFile
                  ariaLabel={t('files.readOnlyMarkdown')}
                  onLoadError={(failure) => setRenderError(failure.message)}
                />
              ) : null}
            </div>
          ) : (
            <SourceViewer
              key={`${agentletId}:${path}`}
              value={result.text}
              readOnly
              plainText
              languageFilename={path}
              onReady={setView}
              searchNodeId={id}
              ariaLabel={t('files.readOnlyText')}
              className="min-h-0 flex-1 overflow-auto"
            />
          )}
        </Suspense>
      ) : null}
      {result?.nextCursor ? (
        <div className="border-edge-default shrink-0 border-t p-2">
          {MAX_PREVIEW_BYTES - loadedBytes.current >= 4 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !!error}
              onClick={() => void more()}
            >
              {t('files.readMore')}
            </Button>
          ) : (
            <span className="text-fg-muted text-xs">
              {t('files.previewLimit')}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
