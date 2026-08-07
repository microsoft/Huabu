// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useEffectiveInputMode } from './useInputMode';
import { createCanvas, importCanvas } from '../api/canvas';

/**
 * Shared "create / import canvas" actions.
 *
 * Extracted from `CanvasListPage` so the title-bar `AppMenu` can offer
 * the same "New canvas" / "Import canvas" entries without duplicating the
 * API call + navigate + toast + loading-flag wiring. Both surfaces render
 * the returned hidden file input and call the returned handlers.
 */
export interface UseCanvasActionsResult {
  create: () => Promise<void>;
  isCreating: boolean;
  /** Opens the OS file picker for import (clicks the hidden input). */
  openImportDialog: () => void;
  isImporting: boolean;
  /** Ref to attach to the hidden `<input type="file">`. */
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  /** `onChange` handler for the hidden file input. */
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
}

export function useCanvasActions(): UseCanvasActionsResult {
  const navigate = useNavigate();
  const inputMode = useEffectiveInputMode();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const create = useCallback(async () => {
    try {
      setIsCreating(true);
      const response = await createCanvas();
      navigate(`/canvas/${response.canvasId}`, {
        state: {
          newCanvasPlacement: {
            canvasId: response.canvasId,
            nodeType: inputMode === 'mouse' ? 'note' : 'sketch',
          },
        },
      });
    } catch (error) {
      console.error('Failed to create canvas:', error);
    } finally {
      setIsCreating(false);
    }
  }, [inputMode, navigate]);

  const openImportDialog = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Reset so the same file can be re-selected if needed.
      e.target.value = '';

      setIsImporting(true);
      try {
        const result = await importCanvas(file);
        navigate(`/canvas/${result.canvasId}`);
      } catch (err) {
        console.error('Failed to import canvas:', err);
      } finally {
        setIsImporting(false);
      }
    },
    [navigate],
  );

  return {
    create,
    isCreating,
    openImportDialog,
    isImporting,
    fileInputRef,
    onFileChange,
  };
}
