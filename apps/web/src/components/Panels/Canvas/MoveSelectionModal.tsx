// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { listCanvases, moveCanvasSelection } from '@/api/canvas';
import { Button } from '@/components/Common/Button';
import { Modal } from '@/components/Common/Modal';
import { Select, type SelectOption } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import useCanvasStore, { drainPendingSaves } from '@/store/canvasStore';

export function MoveSelectionModal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isOpen = useCanvasStore((state) => state.moveSelectionDialogOpen);
  const setOpen = useCanvasStore((state) => state.setMoveSelectionDialogOpen);
  const canvasId = useCanvasStore((state) => state.canvasId);
  const nodes = useCanvasStore((state) => state.nodes);
  const [options, setOptions] = useState<SelectOption<string>[]>([]);
  const [destinationCanvasId, setDestinationCanvasId] = useState('');
  const [destinationKind, setDestinationKind] = useState<'existing' | 'new'>(
    'existing',
  );
  const [newSpaceTitle, setNewSpaceTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const selectedNodeIds = useMemo(
    () => nodes.filter((node) => node.selected).map((node) => node.id),
    [nodes],
  );

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setLoading(true);
    setLoadError(false);
    void listCanvases()
      .then(({ canvases }) => {
        if (!active) return;
        const next = canvases
          .filter((canvas) => canvas.canvasId !== canvasId)
          .map((canvas) => ({
            value: canvas.canvasId,
            label: canvas.title || t('moveSelection.untitledSpace'),
          }));
        setOptions(next);
        setDestinationCanvasId((current) =>
          next.some((option) => option.value === current)
            ? current
            : (next[0]?.value ?? ''),
        );
      })
      .catch(() => {
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canvasId, isOpen, t]);

  const close = () => {
    if (!submitting) setOpen(false);
  };

  const submit = async () => {
    const title = newSpaceTitle.trim();
    if (
      !canvasId ||
      selectedNodeIds.length === 0 ||
      (destinationKind === 'existing' && !destinationCanvasId) ||
      (destinationKind === 'new' && !title)
    ) {
      return;
    }
    setSubmitting(true);
    try {
      await drainPendingSaves();
      const expectedSourceVersion = useCanvasStore.getState().version;
      const result = await moveCanvasSelection(canvasId, {
        selectedNodeIds,
        destination:
          destinationKind === 'existing'
            ? { kind: 'existing', canvasId: destinationCanvasId }
            : { kind: 'new', title },
        expectedSourceVersion,
      });
      setOpen(false);
      toast(
        t('moveSelection.success', {
          count: result.movedNodeCount,
          conversations: result.movedConversationCount,
        }),
        {
          tone: 'success',
          action: {
            label: t('moveSelection.openDestination'),
            onClick: () => navigate(`/canvas/${result.destination.canvasId}`),
          },
        },
      );
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t('moveSelection.failed'),
        { tone: 'danger', duration: 0 },
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title={t('moveSelection.title')}
      description={t('moveSelection.description', {
        count: selectedNodeIds.length,
      })}
      onClose={close}
      closeOnBackdropClick={!submitting}
      closeOnEscape={!submitting}
      footer={
        <>
          <Button variant="ghost" disabled={submitting} onClick={close}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="solid"
            disabled={
              (destinationKind === 'existing' && (loading || loadError)) ||
              submitting ||
              (destinationKind === 'existing' && !destinationCanvasId) ||
              (destinationKind === 'new' && !newSpaceTitle.trim()) ||
              selectedNodeIds.length === 0
            }
            onClick={() => void submit()}
          >
            {submitting
              ? t('moveSelection.moving')
              : t('moveSelection.confirm')}
          </Button>
        </>
      }
    >
      <div className="mt-4">
        <Select
          className="w-full"
          options={[
            {
              value: 'existing',
              label: t('moveSelection.existingDestination'),
            },
            { value: 'new', label: t('moveSelection.newDestination') },
          ]}
          value={destinationKind}
          onChange={setDestinationKind}
          disabled={submitting}
          ariaLabel={t('moveSelection.destinationKind')}
        />
        {destinationKind === 'new' ? (
          <TextInput
            className="mt-3 w-full"
            size="md"
            value={newSpaceTitle}
            onChange={(event) => setNewSpaceTitle(event.target.value)}
            disabled={submitting}
            placeholder={t('moveSelection.newSpaceName')}
            aria-label={t('moveSelection.newSpaceName')}
            autoFocus
          />
        ) : loadError ? (
          <p className="text-danger text-sm">
            {t('moveSelection.targetsUnavailable')}
          </p>
        ) : options.length === 0 && !loading ? (
          <p className="text-fg-muted text-sm">
            {t('moveSelection.noTargets')}
          </p>
        ) : (
          <Select
            className="mt-3 w-full"
            options={options}
            value={destinationCanvasId}
            onChange={setDestinationCanvasId}
            disabled={loading || submitting}
            placeholder={t('moveSelection.selectDestination')}
            ariaLabel={t('moveSelection.selectDestination')}
          />
        )}
        <p className="text-fg-subtle mt-3 text-xs">
          {t('moveSelection.boundaryNotice')}
        </p>
        <p className="text-fg-subtle mt-1 text-xs">
          {t('moveSelection.previewNotice')}
        </p>
      </div>
    </Modal>
  );
}
