// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Eraser } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { NODE_ICON } from '@/config/nodeIcons';
import { useToolStore } from '@/store/toolStore';

const PenIcon = NODE_ICON.sketch;

interface SketchModeSwitcherProps {
  size?: 'sm' | 'md';
  active?: boolean;
  onActivate?: () => void;
}

export function SketchModeSwitcher({
  size = 'md',
  active = true,
  onActivate,
}: SketchModeSwitcherProps) {
  const { t } = useTranslation();
  const mode = useToolStore((state) => state.sketchDraft.mode);
  const setSketchDraft = useToolStore((state) => state.setSketchDraft);

  const selectMode = (nextMode: 'draw' | 'erase') => {
    setSketchDraft({ mode: nextMode });
    onActivate?.();
  };

  return (
    <FloatingToolbar.Group>
      <FloatingToolbar.ToggleButton
        active={active && mode === 'draw'}
        title={t('node.pen')}
        size={size}
        onClick={() => selectMode('draw')}
      >
        <PenIcon />
      </FloatingToolbar.ToggleButton>
      <FloatingToolbar.ToggleButton
        active={active && mode === 'erase'}
        title={t('node.eraser')}
        size={size}
        onClick={() => selectMode('erase')}
      >
        <Eraser />
      </FloatingToolbar.ToggleButton>
    </FloatingToolbar.Group>
  );
}
