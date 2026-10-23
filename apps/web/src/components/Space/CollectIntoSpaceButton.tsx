// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { NODE_ICON } from '@/config/nodeIcons';
import { formatShortcutById } from '@/config/shortcuts';
import useCanvasStore from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { requestCreateChildSpace } from './createChildSpaceAction';

const SpaceIcon = NODE_ICON.spacePreview;

export function CollectIntoSpaceButton() {
  const { t } = useTranslation();
  const canvasId = useCanvasStore((state) => state.canvasId);
  const worldId = useWorkspaceStore((state) => state.worldCanvasId);
  if (canvasId === worldId) return null;
  return (
    <FloatingToolbar.ActionButton
      title={`${t('spaceHierarchy.collectAction')} (${formatShortcutById('layer.collectSpace')})`}
      onClick={() => requestCreateChildSpace()}
    >
      <SpaceIcon />
    </FloatingToolbar.ActionButton>
  );
}
