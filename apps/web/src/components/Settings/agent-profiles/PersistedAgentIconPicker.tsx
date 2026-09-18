// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useRef, useState } from 'react';

import { AgentIconPicker } from './AgentIconPicker';

import type { AgentIconValue } from '@/components/Common/AgentIcon';

interface PersistedAgentIconPickerProps {
  value: AgentIconValue;
  alias: string;
  onSave: (value: AgentIconValue) => Promise<void>;
}

/** Optimistically composes rapid shape/color changes and persists them in order. */
export function PersistedAgentIconPicker({
  value,
  alias,
  onSave,
}: PersistedAgentIconPickerProps) {
  const [optimisticValue, setOptimisticValue] = useState(value);
  const persistedValueRef = useRef(value);
  const saveRef = useRef(onSave);
  const queuedValueRef = useRef<AgentIconValue | null>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);

  persistedValueRef.current = value;
  saveRef.current = onSave;

  useEffect(() => {
    if (!savingRef.current) setOptimisticValue(value);
  }, [value]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const drainQueue = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      while (queuedValueRef.current) {
        const next = queuedValueRef.current;
        queuedValueRef.current = null;
        try {
          await saveRef.current(next);
        } catch {
          if (!queuedValueRef.current && mountedRef.current) {
            setOptimisticValue(persistedValueRef.current);
          }
        }
      }
    } finally {
      savingRef.current = false;
    }
  }, []);

  const handleChange = useCallback(
    (next: AgentIconValue) => {
      setOptimisticValue(next);
      queuedValueRef.current = next;
      void drainQueue();
    },
    [drainQueue],
  );

  return (
    <AgentIconPicker
      value={optimisticValue}
      alias={alias}
      onChange={handleChange}
    />
  );
}
