<script setup lang="ts">
import { watch } from 'vue'
import { useAgentsStore } from '../stores/agents'
import { useSessionStore } from '../stores/session'

const agents = useAgentsStore()
const session = useSessionStore()

function onSelect(sessionId: string) {
  agents.selectSession(sessionId)
  connectIfReady(sessionId)
}

// Auto-connect when a session is auto-selected on load
watch(() => agents.selectedSessionId, (sessionId) => {
  if (sessionId && !session.isConnected) {
    connectIfReady(sessionId)
  }
})

// Re-try connection when sessions list arrives
watch(() => agents.sessions, () => {
  if (agents.selectedSessionId && !session.isConnected) {
    connectIfReady(agents.selectedSessionId)
  }
})

function connectIfReady(sessionId: string) {
  const s = agents.sessions.find(s => s.sessionId === sessionId)
  if (!s) return
  session.connectToSession(sessionId, agents.userToken || undefined)
}
</script>

<template>
  <div class="agent-selector">
    <label>Session:</label>
    <select
      :value="agents.selectedSessionId ?? ''"
      @change="onSelect(($event.target as HTMLSelectElement).value)"
      :disabled="agents.sessions.length === 0"
    >
      <option value="" disabled>Select a session...</option>
      <option
        v-for="s in agents.sessions"
        :key="s.sessionId"
        :value="s.sessionId"
      >
        {{ s.sessionId }} ({{ s.connected ? 'connected' : 'disconnected' }})
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
