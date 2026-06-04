<script setup lang="ts">
import { watch } from 'vue'
import { useAgentsStore } from '../stores/agents'
import { useSessionStore } from '../stores/session'

const agents = useAgentsStore()
const session = useSessionStore()

function onSelect(agentId: string) {
  agents.selectAgent(agentId)
  connectIfReady(agentId)
}

// Auto-connect when an agent is auto-selected on load
watch(() => agents.selectedAgentId, (agentId) => {
  if (agentId && !session.isConnected) {
    connectIfReady(agentId)
  }
})

function connectIfReady(agentId: string) {
  const agent = agents.agents.find(a => a.agentId === agentId)
  if (!agent || agent.status !== 'connected') return
  if (!agent.session?.sessionId) {
    console.warn(`[agentlet-ui] Agent ${agentId} has no active session`)
    return
  }
  session.connectToAgent(agentId, agent.session.sessionId, agents.userToken || undefined)
}
</script>

<template>
  <div class="agent-selector">
    <label>Agent:</label>
    <select
      :value="agents.selectedAgentId ?? ''"
      @change="onSelect(($event.target as HTMLSelectElement).value)"
      :disabled="agents.agents.length === 0"
    >
      <option value="" disabled>Select an agent...</option>
      <option
        v-for="agent in agents.agents"
        :key="agent.agentId"
        :value="agent.agentId"
        :disabled="agent.status !== 'connected'"
      >
        {{ agent.agentId }} ({{ agent.status }})
      </option>
    </select>
    <span class="status" :class="{ online: session.isConnected }">
      {{ session.isConnected ? '● Connected' : '○ Disconnected' }}
    </span>
  </div>
</template>

<style scoped>
.agent-selector {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid #e0e0e0;
  background: #f8f9fa;
}
label {
  font-weight: 600;
  font-size: 14px;
  color: #333;
}
select {
  flex: 1;
  max-width: 400px;
  padding: 6px 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 13px;
  font-family: monospace;
}
.status {
  font-size: 12px;
  color: #999;
}
.status.online {
  color: #22c55e;
}
</style>
