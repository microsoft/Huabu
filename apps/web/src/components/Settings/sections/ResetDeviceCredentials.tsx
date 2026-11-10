// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../Common/Button';
import { Modal } from '../../Common/Modal';
import { toast } from '../../Common/Toast';

/**
 * Revoke one person's device connection credentials, after confirming: their
 * devices disconnect, their running agents stop, and every connection command
 * they copied stops working. Used for oneself and, by administrators, for
 * anyone in People.
 */
export function ResetDeviceCredentials({
  label,
  confirmation,
  done,
  onReset,
  quiet = false,
}: {
  label: string;
  confirmation: string;
  done: string;
  onReset: () => Promise<void>;
  /** A small neutral trigger, for a row among many; the confirmation still warns. */
  quiet?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const reset = async () => {
    setResetting(true);
    try {
      await onReset();
      setOpen(false);
      toast(done, { tone: 'success' });
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : t('settings.resetDeviceCredentialsFailed'),
        { tone: 'danger' },
      );
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <Button
        variant={quiet ? 'ghost' : 'outline'}
        tone={quiet ? 'neutral' : 'danger'}
        size={quiet ? 'sm' : 'field'}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <Modal
        isOpen={open}
        onClose={() => {
          if (!resetting) setOpen(false);
        }}
        title={label}
        initialFocusRef={confirmRef}
      >
        <p className="text-fg-muted text-sm">{confirmation}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            tone="neutral"
            size="field"
            onClick={() => setOpen(false)}
            disabled={resetting}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            variant="solid"
            tone="danger"
            size="field"
            onClick={() => void reset()}
            disabled={resetting}
          >
            {label}
          </Button>
        </div>
      </Modal>
    </>
  );
}
