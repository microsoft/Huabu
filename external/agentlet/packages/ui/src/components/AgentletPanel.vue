<script setup lang="ts">
import { ref, watch } from 'vue'
import { useAgentsStore } from '../stores/agents'
import { useAgentletsStore } from '../stores/agentlets'

const agents = useAgentsStore()
const agentlets = useAgentletsStore()

const command = ref(localStorage.getItem('agentlet-spawn-command') ?? '')
const cwd = ref(localStorage.getItem('agentlet-spawn-cwd') ?? '')
const autoRestart = ref(localStorage.getItem('agentlet-spawn-autorestart') === 'true')
const spawnSessionId = ref('')
const showSpawnForm = ref(false)

watch(() => agents.userToken, (token) => {
  if (token) agentlets.fetchAgentlets(token)
}, { immediate: true })

watch(() => agentlets.selectedAgentletId, (agentletId) => {
  if (agentletId && agents.userToken) {
    agentlets.fetchAgentletSessions(agents.userToken, agentletId)
  }
})

let pollInterval: ReturnType<typeof setInterval> | null = null
watch(() => agents.userToken, (token) => {
  if (pollInterval) clearInterval(pollInterval)
  if (token) { pollInterval = setInterval(() => agentlets.fetchAgentlets(token), 5000) }
}, { immediate: true })

// Persist spawn fields on change
watch(command, (v) => localStorage.setItem('agentlet-spawn-command', v))
watch(cwd, (v) => localStorage.setItem('agentlet-spawn-cwd', v))
watch(autoRestart, (v) => localStorage.setItem('agentlet-spawn-autorestart', String(v)))

async function handleSpawn() {
  if (!command.value.trim() || !agentlets.selectedAgentletId) return
  const sid = spawnSessionId.value.trim() || undefined
  let result
  if (sid) {
    result = await agentlets.resumeSession(
      agents.userToken, agentlets.selectedAgentletId, sid, command.value.trim(), cwd.value.trim() || undefined
    )
  } else {
    result = await agentlets.spawnAgent(agents.userToken, agentlets.selectedAgentletId, {
      command: command.value.trim(),
      cwd: cwd.value.trim() || undefined,
      autoRestart: autoRestart.value,
    })
  }
  if (result) {
    showSpawnForm.value = false
    spawnSessionId.value = ''
    if (agentlets.selectedAgentletId) {
      agentlets.fetchAgentletSessions(agents.userToken, agentlets.selectedAgentletId)
    }
    setTimeout(() => agents.fetchSessions(), 1000)
  }
}

async function handleStop(sessionId: string) {
  if (!agentlets.selectedAgentletId) return
  const ok = await agentlets.stopAgent(agents.userToken, agentlets.selectedAgentletId, sessionId)
  if (ok && agentlets.selectedAgentletId) {
    agentlets.fetchAgentletSessions(agents.userToken, agentlets.selectedAgentletId)
    setTimeout(() => agents.fetchSessions(), 1000)
  }
}
</script>

<template>
  <div class="agentlet-panel">
    <div class="panel-header">
      <h3>Agentlets</h3>
      <span class="count">{{ agentlets.agentlets.length }}</span>
    </div>

    <div v-if="agentlets.agentlets.length === 0" class="empty">
      No agentlets connected
    </div>

    <div v-else>
      <div class="agentlet-list">
        <div
          v-for="agentlet in agentlets.agentlets"
          :key="agentlet.agentletId"
          class="agentlet-item"
          :class="{ selected: agentlets.selectedAgentletId === agentlet.agentletId }"
          @click="agentlets.selectAgentlet(agentlet.agentletId)"
        >
          <span class="status-dot" :class="agentlet.connected ? 'connected' : 'disconnected'"></span>
          <div class="agentlet-info">
            <span class="agentlet-id">{{ agentlet.agentletId }}</span>
            <span class="agentlet-meta" v-if="agentlet.machine">
              {{ agentlet.machine.hostname }} ({{ agentlet.machine.platform }})
            </span>
          </div>
        </div>
      </div>

      <!-- Selected agentlet detail -->
      <div v-if="agentlets.selectedAgentletId" class="agentlet-detail">
        <div class="detail-header">
          <span class="detail-title">Sessions on agentlet</span>
          <button class="spawn-btn" @click="showSpawnForm = !showSpawnForm">
            {{ showSpawnForm ? '✕ Cancel' : '+ Spawn Agent' }}
          </button>
        </div>

        <!-- Spawn form -->
        <div v-if="showSpawnForm" class="spawn-form">
          <div class="form-field">
            <label>Command</label>
            <input v-model="command" placeholder='e.g. copilot --acp --allow-all' />
          </div>
          <div class="form-field">
            <label>Working Directory</label>
            <input v-model="cwd" placeholder='(optional) e.g. /home/user/project' />
          </div>
          <div class="form-field">
            <label>Session ID</label>
            <input v-model="spawnSessionId" placeholder='(optional) existing session ID to resume' />
          </div>
          <div class="form-field checkbox">
            <input type="checkbox" id="auto-restart" v-model="autoRestart" />
            <label for="auto-restart">Auto-restart on crash</label>
          </div>
          <button class="submit-btn" @click="handleSpawn" :disabled="!command.trim() || agentlets.spawning">
            {{ agentlets.spawning ? 'Spawning...' : (spawnSessionId.trim() ? 'Resume' : 'Spawn') }}
          </button>
          <div v-if="agentlets.error" class="error">{{ agentlets.error }}</div>
        </div>

        <!-- Session list on agentlet -->
        <div class="agentlet-sessions">
          <div v-if="agentlets.agentletSessions.length === 0" class="empty-sessions">
            No sessions running on this agentlet
          </div>
          <div v-for="session in agentlets.agentletSessions" :key="session.sessionId" class="session-row">
            <div class="session-info">
              <span class="session-id">{{ session.sessionId }}</span>
              <span class="session-cmd">{{ session.command }}</span>
              <span class="session-meta">PID: {{ session.pid }} | {{ session.cwd }}</span>
            </div>
            <button class="stop-btn" @click="handleStop(session.sessionId)">Stop</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agentlet-panel { padding: 12px 16px; border-top: 1px solid #e0e0e0; }
.panel-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.panel-header h3 { margin: 0; font-size: 14px; color: #333; }
.count { background: #e0e0e0; color: #555; font-size: 11px; padding: 1px 6px; border-radius: 8px; }
.empty { color: #999; font-size: 13px; font-style: italic; }
.agentlet-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.agentlet-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid #e0e0e0; border-radius: 4px; cursor: pointer; transition: background 0.1s; }
.agentlet-item:hover { background: #f5f5f5; }
.agentlet-item.selected { background: #e8f4fd; border-color: #90caf9; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.status-dot.connected { background: #22c55e; }
.status-dot.disconnected { background: #ef4444; }
.agentlet-info { display: flex; flex-direction: column; min-width: 0; }
.agentlet-id { font-size: 12px; font-family: monospace; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agentlet-meta { font-size: 11px; color: #888; }
.agentlet-detail { border-top: 1px solid #eee; padding-top: 10px; }
.detail-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.detail-title { font-size: 13px; font-weight: 600; color: #555; }
.spawn-btn { background: #2196f3; color: white; border: none; border-radius: 4px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
.spawn-btn:hover { background: #1976d2; }
.spawn-form { background: #f8f9fa; border: 1px solid #e0e0e0; border-radius: 6px; padding: 12px; margin-bottom: 10px; }
.form-field { margin-bottom: 8px; }
.form-field label { display: block; font-size: 12px; color: #555; margin-bottom: 3px; }
.form-field input[type="text"], .form-field input:not([type]) { width: 100%; padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; font-family: monospace; box-sizing: border-box; }
.form-field.checkbox { display: flex; align-items: center; gap: 6px; }
.form-field.checkbox label { margin: 0; }
.submit-btn { background: #4caf50; color: white; border: none; border-radius: 4px; padding: 6px 16px; font-size: 13px; cursor: pointer; }
.submit-btn:hover { background: #388e3c; }
.submit-btn:disabled { background: #ccc; cursor: not-allowed; }
.error { color: #ef4444; font-size: 12px; margin-top: 6px; }
.agentlet-sessions { display: flex; flex-direction: column; gap: 4px; }
.empty-sessions { color: #999; font-size: 12px; font-style: italic; }
.session-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; background: #fafafa; border: 1px solid #eee; border-radius: 4px; }
.session-info { display: flex; flex-direction: column; min-width: 0; }
.session-id { font-size: 11px; font-family: monospace; color: #333; }
.session-cmd { font-size: 11px; color: #666; }
.session-meta { font-size: 10px; color: #999; }
.stop-btn { background: #ef4444; color: white; border: none; border-radius: 4px; padding: 3px 10px; font-size: 11px; cursor: pointer; }
.stop-btn:hover { background: #dc2626; }
</style>
