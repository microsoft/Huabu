// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { FLOATING_TOOLBAR_POPOVER_CLASS } from '@/components/Common/FloatingToolbar';
import { Popover } from '@/components/Common/Popover';
import { Select, type SelectOption } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';

import type { MoveSelectionBody } from '@huabu/shared';

const NEW_SPACE_DESTINATION = '__new_space__';
const FIELD_CLASS =
  'h-8 min-h-8 w-full rounded-md px-2 py-1 text-[13px] leading-5 font-normal';

interface MoveSelectionPanelProps {
  reference?: HTMLElement | null;
  boundary?: Element | null;
  count: number;
  includesFrames: boolean;
  options: SelectOption<string>[];
  loading?: boolean;
  loadError?: boolean;
  submitting?: boolean;
  onClose: () => void;
  onSubmit: (
    destination: MoveSelectionBody['destination'],
    createSourcePreview: boolean,
  ) => void;
}

export function MoveSelectionPanel({
  reference,
  boundary,
  count,
  includesFrames,
  options,
  loading = false,
  loadError = false,
  submitting = false,
  onClose,
  onSubmit,
}: MoveSelectionPanelProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const noticeId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [selectedDestination, setSelectedDestination] = useState('');
  const [newSpaceTitle, setNewSpaceTitle] = useState('');
  const [createSourcePreview, setCreateSourcePreview] = useState(true);
  const creatingNewSpace = selectedDestination === NEW_SPACE_DESTINATION;
  const destinationCanvasId = options.some(
    (option) => option.value === selectedDestination,
  )
    ? selectedDestination
    : (options[0]?.value ?? '');
  const statusOption = loading
    ? { value: '__loading__', label: t('moveSelection.loadingTargets') }
    : loadError
      ? {
          value: '__load_error__',
          label: t('moveSelection.targetsUnavailable'),
        }
      : options.length === 0
        ? { value: '__empty__', label: t('moveSelection.noTargets') }
        : null;
  const destinationOptions: SelectOption<string>[] = [
    ...(statusOption ? [{ ...statusOption, disabled: true }] : options),
    {
      value: NEW_SPACE_DESTINATION,
      label: t('moveSelection.createNewDestination'),
      separatorBefore: true,
    },
  ];

  useEffect(() => {
    const form = formRef.current;
    const previousFocus =
      reference ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    return () => {
      if (
        previousFocus?.isConnected &&
        (document.activeElement === document.body ||
          (document.activeElement && form?.contains(document.activeElement)))
      ) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [reference]);

  useEffect(() => {
    if (creatingNewSpace) nameRef.current?.focus();
  }, [creatingNewSpace]);

  const canSubmit =
    count > 0 &&
    !submitting &&
    (creatingNewSpace
      ? Boolean(newSpaceTitle.trim())
      : !loading && !loadError && Boolean(destinationCanvasId));

  return (
    <Popover
      reference={reference}
      boundary={boundary}
      placement="bottom-start"
      onOpenAutoFocus={() =>
        formRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      }
      onDismiss={submitting ? undefined : onClose}
      dismissOnEscape={false}
      className={`${FLOATING_TOOLBAR_POPOVER_CLASS} text-fg-default max-h-[calc(100dvh-24px)] w-80 overflow-y-auto overscroll-contain p-3 text-[13px] leading-5`}
    >
      {/* Escape bubbles here only after nested popovers have handled it. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <form
        ref={formRef}
        role="dialog"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId} ${noticeId}`}
        aria-busy={submitting}
        className="flex min-w-0 flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit)
            onSubmit(
              creatingNewSpace
                ? { kind: 'new', title: newSpaceTitle.trim() }
                : { kind: 'existing', canvasId: destinationCanvasId },
              createSourcePreview,
            );
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          if (!submitting) onClose();
        }}
      >
        <div className="flex flex-col gap-1">
          <h3 id={titleId} className="font-medium">
            {t('moveSelection.title')}
          </h3>
          <p
            id={descriptionId}
            className="text-fg-muted text-xs leading-[18px]"
          >
            {t('moveSelection.description', { count })}
            {includesFrames && ` ${t('moveSelection.frameNotice')}`}
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <Select
            className={`${FIELD_CLASS} justify-between`}
            options={destinationOptions}
            value={
              creatingNewSpace
                ? NEW_SPACE_DESTINATION
                : (statusOption?.value ?? destinationCanvasId)
            }
            onChange={setSelectedDestination}
            disabled={submitting}
            ariaLabel={t('moveSelection.selectDestination')}
          />
          {creatingNewSpace && (
            <TextInput
              ref={nameRef}
              className={FIELD_CLASS}
              name="new-space-title"
              autoComplete="off"
              value={newSpaceTitle}
              onChange={(event) => setNewSpaceTitle(event.target.value)}
              disabled={submitting}
              placeholder={t('moveSelection.newSpaceName')}
              aria-label={t('moveSelection.newSpaceName')}
              required
            />
          )}
        </div>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            className="accent-info mt-0.5 h-4 w-4 shrink-0 cursor-pointer"
            checked={createSourcePreview}
            onChange={(event) => setCreateSourcePreview(event.target.checked)}
            disabled={submitting}
          />
          <span>{t('moveSelection.createSourcePreview')}</span>
        </label>
        <div className="flex flex-col gap-2">
          <p id={noticeId} className="text-fg-muted text-xs leading-[18px]">
            {t('moveSelection.boundaryNotice')}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-md text-[13px] font-normal"
              disabled={submitting}
              onClick={onClose}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              type="submit"
              variant="solid"
              size="sm"
              className="h-8 rounded-md text-[13px] font-normal"
              disabled={!canSubmit}
            >
              {submitting
                ? t('moveSelection.moving')
                : t('moveSelection.confirm')}
            </Button>
          </div>
        </div>
      </form>
    </Popover>
  );
}
