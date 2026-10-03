// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { CommandProfileForm } from './CommandProfileForm';

import type {
  AcpAgentCliInfo,
  AgentProfileView,
  ConnectedAgentletDevice,
} from '@huabu/shared';

type AgentProfileEditorProps = {
  detectedClis: AcpAgentCliInfo[];
  detectionLoaded: boolean;
  connectedDevices: ConnectedAgentletDevice[];
  agentletId: string;
  onAgentletChange: (agentletId: string) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
} & ({ mode: 'create' } | { mode: 'edit-command'; profile: AgentProfileView });

export function AgentProfileEditor(props: AgentProfileEditorProps) {
  return (
    <CommandProfileForm
      key={
        props.mode === 'create'
          ? 'create'
          : `${props.profile.id}:${props.profile.revision ?? 0}`
      }
      editing={props.mode === 'create' ? null : props.profile}
      detectedClis={props.detectedClis}
      detectionLoaded={props.detectionLoaded}
      connectedDevices={props.connectedDevices}
      agentletId={props.agentletId}
      onAgentletChange={props.onAgentletChange}
      onClose={props.onClose}
      onSaved={props.onSaved}
    />
  );
}
