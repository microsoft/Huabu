// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { CommandProfileForm } from './CommandProfileForm';

import type { AcpAgentCliInfo, AgentProfileView } from '@huabu/shared';

type AgentProfileEditorProps = {
  detectedClis: AcpAgentCliInfo[];
  detectionLoaded: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
} & ({ mode: 'create' } | { mode: 'edit-command'; profile: AgentProfileView });

export function AgentProfileEditor(props: AgentProfileEditorProps) {
  return (
    <CommandProfileForm
      editing={props.mode === 'create' ? null : props.profile}
      detectedClis={props.detectedClis}
      detectionLoaded={props.detectionLoaded}
      onClose={props.onClose}
      onSaved={props.onSaved}
    />
  );
}
