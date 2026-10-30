// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isFileReference } from '@huabu/shared';

import { readDeviceFile } from '@/api/device-files';
import { Button } from '@/components/Common/Button';
import useCanvasStore from '@/store/canvasStore';

import type { PreviewComponentProps } from '../previews';
import type { EditorView } from '@codemirror/view';
import type { FileReadResult } from '@huabu/shared';

const SourceViewer = lazy(
  () => import('@/components/CodeMirror/RawMarkdownEditor'),
);
const CommentActions = lazy(async () => ({
  default: (await import('./FileCommentActions')).FileCommentActions,
}));
const MAX_PREVIEW_BYTES = 262_144;

export function FileReferencePreview({ id, data }: PreviewComponentProps) {
  const { t } = useTranslation();
  const reference = isFileReference(data.fileReference)
    ? data.fileReference
    : null;
  const agentletId = reference?.agentletId;
  const path = reference?.path;
  const [result, setResult] = useState<FileReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const loadedBytes = useRef(0);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasId = useCanvasStore((state) => state.canvasId);
  const [view, setView] = useState<EditorView | null>(null);
  useEffect(() => {
    const current = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    loadedBytes.current = 0;
    setResult(null);
    setError(null);
    if (!agentletId || !path) return;
    setPending(true);
    void readDeviceFile(agentletId, { path }, abort.signal)
      .then((value) => {
        if (current !== generation.current) return;
        loadedBytes.current = value.byteLength;
        setResult(value);
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
  }, [agentletId, path, refresh, t]);

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
      setResult({ ...next, text: result.text + next.text });
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
  return (
    <div ref={surfaceRef} className="flex h-full min-h-0 flex-col">
      {id && canvasId && agentletId ? (
        <Suspense fallback={null}>
          <CommentActions
            key={`${canvasId}\0${id}\0${agentletId}\0${path}`}
            view={view}
            surfaceRef={surfaceRef}
            canvasId={canvasId}
            nodeId={id}
            agentletId={agentletId}
            file={result}
            disabled={pending || !!error}
          />
        </Suspense>
      ) : null}
      <div className="border-edge-default flex shrink-0 flex-wrap items-center gap-2 border-b p-2 text-xs">
        <span className="text-fg-muted min-w-0 flex-1 break-all">
          {reference.deviceName ?? agentletId} · {path}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {t('files.refresh')}
        </Button>
      </div>
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
          <SourceViewer
            key={`${agentletId}:${path}`}
            value={result.text}
            readOnly
            plainText
            onReady={setView}
            searchNodeId={id}
            ariaLabel={t('files.readOnlyText')}
            className="min-h-0 flex-1 overflow-auto"
          />
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
