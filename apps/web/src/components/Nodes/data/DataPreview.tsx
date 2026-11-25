// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Pencil,
  ShieldCheck,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';
import { parseAndNormalizeDataNodeContent } from '@huabu/shared/data-node-validation';

import { ApiError } from '@/api/_client';
import {
  CanvasConflictError,
  getNodeContent,
  putNodeContent,
} from '@/api/canvas';
import { Button } from '@/components/Common/Button';
import { Modal } from '@/components/Common/Modal';
import { TextArea } from '@/components/Common/TextArea';
import { usePreviewHeaderSlot } from '@/components/Nodes/PreviewHeaderSlot';
import { getElectronBridge } from '@/hooks/useElectron';
import useCanvasStore, {
  adoptRemoteNodeContent,
  selectCanWriteCanvas,
} from '@/store/canvasStore';

import type { PreviewComponentProps } from '../previews';
import type { DataNodeSchemaV1 } from '@huabu/shared/data-node-validation';

interface ConflictState {
  latestRev: string;
  latestContent: string;
  latestSchema: DataNodeSchemaV1 | null;
}

function computeLocalRev(
  data: Record<string, unknown>,
  content: string,
  dataSchema: DataNodeSchemaV1 | null,
): string {
  return nodeRevisionOf({
    ...data,
    type: 'data',
    content,
    ...(dataSchema ? { dataSchema } : {}),
  });
}

function formatDisplayJson(rawContent: string): {
  formatted: string;
  parseError: string | null;
} {
  try {
    const parsed = JSON.parse(rawContent);
    return { formatted: JSON.stringify(parsed, null, 2), parseError: null };
  } catch (error) {
    return {
      formatted: rawContent,
      parseError:
        error instanceof Error ? error.message : 'Invalid JSON syntax',
    };
  }
}

export function DataPreview({
  id,
  data,
  readOnly = false,
  onContentChange,
}: PreviewComponentProps) {
  const { t } = useTranslation();
  const { el: headerSlotEl } = usePreviewHeaderSlot();
  const canvasId = useCanvasStore((state) => state.canvasId);
  const canWriteCanvas = useCanvasStore(selectCanWriteCanvas);
  const canEdit = !readOnly && canWriteCanvas;

  const rawContent = typeof data.content === 'string' ? data.content : '{}';
  const storedSchema =
    (data.dataSchema as DataNodeSchemaV1 | undefined) ?? null;

  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [baselineText, setBaselineText] = useState('');
  const [baseRev, setBaseRev] = useState('');
  const [activeSchema, setActiveSchema] = useState<DataNodeSchemaV1 | null>(
    storedSchema,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [schemaExpanded, setSchemaExpanded] = useState(false);

  // Reset editing state when switching previewed node id.
  useEffect(() => {
    setIsEditing(false);
    setDraftText('');
    setBaselineText('');
    setSaveError(null);
    setConflict(null);
    setConfirmDiscardOpen(false);
    setActiveSchema(storedSchema);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep schema in sync when not actively editing.
  useEffect(() => {
    if (!isEditing) {
      setActiveSchema(storedSchema);
    }
  }, [isEditing, storedSchema]);

  const effectiveSchema = isEditing ? activeSchema : storedSchema;
  const displayJson = useMemo(
    () => formatDisplayJson(rawContent),
    [rawContent],
  );
  const readOnlyValidation = useMemo(
    () => parseAndNormalizeDataNodeContent(rawContent, effectiveSchema),
    [effectiveSchema, rawContent],
  );
  const draftValidation = useMemo(
    () =>
      isEditing
        ? parseAndNormalizeDataNodeContent(draftText, effectiveSchema)
        : null,
    [draftText, effectiveSchema, isEditing],
  );

  const isDirty = isEditing && draftText !== baselineText;

  // Warn before closing browser tab when holding unsaved JSON draft changes.
  useEffect(() => {
    if (!isDirty || typeof window === 'undefined') {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (getElectronBridge()) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  // Intercept Escape in capture phase while dirty so ExpandedNodePanel does not
  // silently close and discard unsaved JSON edits.
  useEffect(() => {
    if (!isDirty || confirmDiscardOpen || typeof window === 'undefined') {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setConfirmDiscardOpen(true);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [confirmDiscardOpen, isDirty]);

  const beginEdit = useCallback(() => {
    if (!canEdit) {
      return;
    }
    const initialText = displayJson.formatted;
    const initialRev = computeLocalRev(data, rawContent, storedSchema);
    setDraftText(initialText);
    setBaselineText(initialText);
    setBaseRev(initialRev);
    setActiveSchema(storedSchema);
    setSaveError(null);
    setConflict(null);
    setIsEditing(true);

    // Refresh baseline revision from authoritative server sidecar if available.
    if (canvasId && id) {
      void getNodeContent(canvasId, id)
        .then((res) => {
          if (!res || res.contentMissing) {
            return;
          }
          const remoteFormatted = formatDisplayJson(res.content).formatted;
          setBaseRev(res.rev);
          setActiveSchema(res.dataSchema ?? null);
          setDraftText((current) =>
            current === initialText ? remoteFormatted : current,
          );
          setBaselineText(remoteFormatted);
        })
        .catch(() => undefined);
    }
  }, [
    canEdit,
    canvasId,
    data,
    displayJson.formatted,
    id,
    rawContent,
    storedSchema,
  ]);

  const discardAndExitEdit = useCallback(() => {
    setConfirmDiscardOpen(false);
    setIsEditing(false);
    setSaveError(null);
    setConflict(null);
  }, []);

  const handleCancelClick = useCallback(() => {
    if (isDirty) {
      setConfirmDiscardOpen(true);
      return;
    }
    discardAndExitEdit();
  }, [discardAndExitEdit, isDirty]);

  const handleFormatDraft = useCallback(() => {
    if (draftValidation?.ok) {
      setDraftText(draftValidation.formatted);
    }
  }, [draftValidation]);

  const performSave = useCallback(
    async (expectRevision: string) => {
      if (!draftValidation || !draftValidation.ok) {
        return;
      }
      if (!canvasId || !id) {
        onContentChange?.(draftValidation.formatted);
        setIsEditing(false);
        setSaveError(null);
        setConflict(null);
        return;
      }

      setSaving(true);
      setSaveError(null);
      try {
        const res = await putNodeContent(canvasId, id, {
          nodeType: 'data',
          content: draftValidation.formatted,
          expectRev: expectRevision,
        });
        await adoptRemoteNodeContent(canvasId, [id]).catch(() => undefined);
        setBaseRev(res.rev);
        setBaselineText(draftValidation.formatted);
        setDraftText(draftValidation.formatted);
        setConflict(null);
        setIsEditing(false);
      } catch (error) {
        const isConflict =
          (error instanceof CanvasConflictError &&
            error.code === 'NODE_CONTENT_CONFLICT') ||
          (error instanceof ApiError && error.status === 409);
        if (isConflict) {
          let latestRev =
            error instanceof CanvasConflictError && error.currentRev
              ? error.currentRev
              : expectRevision;
          let latestContent = rawContent;
          let latestSchema = effectiveSchema;
          try {
            const latest = await getNodeContent(canvasId, id);
            if (latest && !latest.contentMissing) {
              latestRev = latest.rev;
              latestContent = latest.content;
              latestSchema = latest.dataSchema ?? null;
              setActiveSchema(latestSchema);
            }
          } catch {
            // Keep draft intact even if secondary fetch fails.
          }
          setConflict({
            latestRev,
            latestContent,
            latestSchema,
          });
          return;
        }
        setSaveError(error instanceof Error ? error.message : String(error));
      } finally {
        setSaving(false);
      }
    },
    [
      canvasId,
      draftValidation,
      effectiveSchema,
      id,
      onContentChange,
      rawContent,
    ],
  );

  const handleReloadLatest = useCallback(async () => {
    if (!conflict) {
      return;
    }
    if (canvasId && id) {
      await adoptRemoteNodeContent(canvasId, [id]).catch(() => undefined);
    }
    const formattedLatest = formatDisplayJson(conflict.latestContent).formatted;
    setDraftText(formattedLatest);
    setBaselineText(formattedLatest);
    setBaseRev(conflict.latestRev);
    setActiveSchema(conflict.latestSchema);
    setConflict(null);
    setSaveError(null);
  }, [canvasId, conflict, id]);

  const handleOverwriteWithDraft = useCallback(() => {
    if (!conflict) {
      return;
    }
    setBaseRev(conflict.latestRev);
    void performSave(conflict.latestRev);
  }, [conflict, performSave]);

  const headerActions = (
    <div className="flex items-center gap-1.5">
      {!isEditing ? (
        canEdit ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={beginEdit}
            data-testid="data-preview-edit"
          >
            <Pencil className="mr-1.5 h-3.5 w-3.5" />
            {t('dataNode.edit')}
          </Button>
        ) : (
          <span className="text-fg-subtle text-xs">
            {t('dataNode.readOnlyBadge')}
          </span>
        )
      ) : (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleFormatDraft}
            disabled={!draftValidation?.ok || saving}
            data-testid="data-preview-format"
          >
            {t('dataNode.format')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCancelClick}
            disabled={saving}
            data-testid="data-preview-cancel"
          >
            {t('dataNode.cancel')}
          </Button>
          <Button
            variant="solid"
            size="sm"
            onClick={() => void performSave(baseRev)}
            disabled={!draftValidation?.ok || saving}
            data-testid="data-preview-save"
          >
            {saving ? t('dataNode.saving') : t('dataNode.save')}
          </Button>
        </>
      )}
    </div>
  );

  return (
    <div
      className="bg-surface text-fg-default flex h-full flex-col overflow-hidden"
      data-testid="data-preview"
    >
      {headerSlotEl ? (
        createPortal(headerActions, headerSlotEl)
      ) : (
        <div className="border-edge-default flex items-center justify-end border-b px-4 py-2">
          {headerActions}
        </div>
      )}

      {effectiveSchema && (
        <div className="border-edge-default bg-bg-default border-b px-4 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-fg-muted flex items-center gap-1.5 text-xs font-medium">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              <span>{t('dataNode.schemaTitle')}</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSchemaExpanded((prev) => !prev)}
              data-testid="data-preview-toggle-schema"
            >
              {schemaExpanded ? (
                <>
                  <ChevronDown className="mr-1 h-3.5 w-3.5" />
                  {t('dataNode.hideSchema')}
                </>
              ) : (
                <>
                  <ChevronRight className="mr-1 h-3.5 w-3.5" />
                  {t('dataNode.showSchema')}
                </>
              )}
            </Button>
          </div>
          {schemaExpanded && (
            <pre
              className="border-edge-default bg-surface text-fg-muted mt-2 max-h-48 overflow-auto rounded border p-2.5 font-mono text-xs leading-relaxed"
              data-testid="data-preview-schema-json"
            >
              {JSON.stringify(effectiveSchema, null, 2)}
            </pre>
          )}
        </div>
      )}

      {conflict && (
        <div
          role="alert"
          className="border-edge-default bg-bg-default flex flex-col gap-2 border-b px-4 py-3"
          data-testid="data-preview-conflict-banner"
        >
          <div className="text-warning flex items-center gap-2 text-xs font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{t('dataNode.conflictTitle')}</span>
          </div>
          <p className="text-fg-muted text-xs">{t('dataNode.conflictHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleReloadLatest()}
              disabled={saving}
              data-testid="data-preview-conflict-reload"
            >
              {t('dataNode.reloadLatest')}
            </Button>
            <Button
              variant="solid"
              size="sm"
              onClick={handleOverwriteWithDraft}
              disabled={!draftValidation?.ok || saving}
              data-testid="data-preview-conflict-overwrite"
            >
              {t('dataNode.overwriteWithDraft')}
            </Button>
          </div>
        </div>
      )}

      {isEditing && draftValidation && !draftValidation.ok && (
        <div
          role="alert"
          className="border-edge-default bg-bg-default text-danger border-b px-4 py-2 text-xs"
          data-testid="data-preview-validation-error"
        >
          {t('dataNode.validationError', {
            message: draftValidation.message,
          })}
        </div>
      )}

      {!isEditing && !readOnlyValidation.ok && (
        <div
          role="alert"
          className="border-edge-default bg-bg-default text-danger border-b px-4 py-2 text-xs"
          data-testid="data-preview-readonly-error"
        >
          {t('dataNode.validationError', {
            message: readOnlyValidation.message,
          })}
        </div>
      )}

      {saveError && (
        <div
          role="alert"
          className="border-edge-default bg-bg-default text-danger border-b px-4 py-2 text-xs"
          data-testid="data-preview-save-error"
        >
          {t('dataNode.saveError', { message: saveError })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {isEditing ? (
          <TextArea
            mono
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            spellCheck={false}
            aria-label={t('dataNode.edit')}
            className="h-full min-h-[280px] w-full resize-none leading-relaxed"
            data-testid="data-preview-editor"
          />
        ) : (
          <pre
            className="bg-bg-default border-edge-default text-fg-default min-h-full overflow-auto rounded border p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
            data-testid="data-preview-readonly-json"
          >
            {displayJson.formatted || t('dataNode.emptyValue')}
          </pre>
        )}
      </div>

      <Modal
        isOpen={confirmDiscardOpen}
        title={t('dataNode.discardModalTitle')}
        description={t('dataNode.discardModalBody')}
        onClose={() => setConfirmDiscardOpen(false)}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDiscardOpen(false)}
              data-testid="data-preview-keep-editing"
            >
              {t('dataNode.keepEditing')}
            </Button>
            <Button
              variant="solid"
              tone="danger"
              size="sm"
              onClick={discardAndExitEdit}
              data-testid="data-preview-confirm-discard"
            >
              {t('dataNode.discardChanges')}
            </Button>
          </div>
        }
      />
    </div>
  );
}
