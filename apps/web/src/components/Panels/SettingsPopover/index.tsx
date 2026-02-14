import { Settings } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { MigrationProgress } from './MigrationProgress';
import { MigrationResult } from './MigrationResult';
import { StorageSettingsForm } from './StorageSettingsForm';
import { countMigratableNodes } from './types';
import { migrateStorage } from '../../../api/canvas';
import useCanvasStore from '../../../store/canvasStore';
import { IconButton } from '../../Common/IconButton';

import type { KnowledgeStorageBackend, KnowledgeStorageConfig } from './types';
import type { MigrateStorageResponse } from '@sediment/shared';

type PopoverPhase = 'settings' | 'confirm' | 'migrating' | 'result';

/**
 * Settings popover that lets users configure the knowledge storage backend.
 * Includes a migration flow when switching backends with existing content.
 * Anchored to a trigger button and rendered via a portal.
 */
export const SettingsPopover: React.FC = () => {
  const storageConfig = useCanvasStore((s) => s.storageConfig);
  const setStorageConfig = useCanvasStore((s) => s.setStorageConfig);
  const loadCanvas = useCanvasStore((s) => s.loadCanvas);
  const nodes = useCanvasStore((s) => s.nodes);
  const canvasId = useCanvasStore((s) => s.canvasId);

  const [isOpen, setIsOpen] = useState(false);
  const [backend, setBackend] = useState<KnowledgeStorageBackend>(
    storageConfig.backend,
  );
  const [vaultPath, setVaultPath] = useState(
    storageConfig.obsidianVaultPath ?? '',
  );
  const [error, setError] = useState('');

  // Migration flow state
  const [phase, setPhase] = useState<PopoverPhase>('settings');
  const [migratableCount, setMigratableCount] = useState(0);
  const [migrationResult, setMigrationResult] =
    useState<MigrateStorageResponse | null>(null);
  const [migrationError, setMigrationError] = useState('');

  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Sync local state when store changes (e.g. after canvas load)
  useEffect(() => {
    setBackend(storageConfig.backend);
    setVaultPath(storageConfig.obsidianVaultPath ?? '');
  }, [storageConfig]);

  // Close on outside click (only when not migrating)
  useEffect(() => {
    if (!isOpen) return;

    const handleClick = (e: MouseEvent) => {
      if (phase === 'migrating') return;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        handleClose();
      }
    };

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen, phase]);

  // ─── Helpers ────────────────────────────────────────────────────

  const resetMigrationState = () => {
    setPhase('settings');
    setMigrationResult(null);
    setMigrationError('');
  };

  const handleClose = () => {
    setBackend(storageConfig.backend);
    setVaultPath(storageConfig.obsidianVaultPath ?? '');
    setError('');
    resetMigrationState();
    setIsOpen(false);
  };

  const isConfigChanged = (): boolean => {
    if (backend !== storageConfig.backend) return true;
    if (
      backend === 'obsidian' &&
      vaultPath.trim() !== (storageConfig.obsidianVaultPath ?? '')
    ) {
      return true;
    }
    return false;
  };

  const buildNewConfig = (): KnowledgeStorageConfig => ({
    backend,
    obsidianVaultPath: backend === 'obsidian' ? vaultPath.trim() : undefined,
  });

  // ─── Handlers ───────────────────────────────────────────────────

  const handleBackendChange = (next: KnowledgeStorageBackend) => {
    setBackend(next);
    setError('');
  };

  const handleVaultPathChange = (path: string) => {
    setVaultPath(path);
    if (error) setError('');
  };

  const handleSave = () => {
    if (backend === 'obsidian' && !vaultPath.trim()) {
      setError('Obsidian vault path is required');
      return;
    }
    setError('');

    const newConfig = buildNewConfig();

    if (!isConfigChanged()) {
      setStorageConfig(newConfig);
      setIsOpen(false);
      return;
    }

    const count = countMigratableNodes(nodes);
    if (count === 0) {
      setStorageConfig(newConfig);
      setIsOpen(false);
      return;
    }

    setMigratableCount(count);
    // Directly start migration instead of asking for confirmation
    void (async () => {
      setPhase('migrating');
      setMigrationError('');

      try {
        const result = await migrateStorage(canvasId, newConfig);
        setMigrationResult(result);
        setPhase('result');
        await loadCanvas();
      } catch (err) {
        setMigrationError(
          err instanceof Error ? err.message : 'Migration failed',
        );
        setPhase('result');
      }
    })();
  };

  // ─── Popover positioning ────────────────────────────────────────

  const getPopoverStyle = (): React.CSSProperties => {
    if (!triggerRef.current) return {};
    const rect = triggerRef.current.getBoundingClientRect();
    return {
      position: 'fixed',
      top: rect.bottom + 6,
      right: window.innerWidth - rect.right,
      zIndex: 9999,
    };
  };

  // ─── Render ─────────────────────────────────────────────────────

  const renderContent = () => {
    switch (phase) {
      case 'settings':
        return (
          <StorageSettingsForm
            backend={backend}
            vaultPath={vaultPath}
            error={error}
            onBackendChange={handleBackendChange}
            onVaultPathChange={handleVaultPathChange}
            onSave={handleSave}
            onCancel={handleClose}
          />
        );
      case 'migrating':
        return <MigrationProgress migratableCount={migratableCount} />;
      case 'result':
        return (
          <MigrationResult
            result={migrationResult}
            error={migrationError}
            onClose={handleClose}
          />
        );
    }
  };

  return (
    <>
      <div ref={triggerRef}>
        <IconButton
          title="Settings"
          onClick={() => setIsOpen((prev) => !prev)}
          aria-label="Open settings"
        >
          <Settings size={18} />
        </IconButton>
      </div>

      {isOpen &&
        createPortal(
          <div
            ref={popoverRef}
            style={getPopoverStyle()}
            className="border-border w-80 rounded-lg border bg-white p-4 shadow-lg"
          >
            {renderContent()}
          </div>,
          document.body,
        )}
    </>
  );
};
