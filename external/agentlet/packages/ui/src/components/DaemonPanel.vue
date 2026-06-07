<script setup lang="ts">
import { ref, watch } from 'vue'
import { useAgentsStore } from '../stores/agents'
import { useDaemonsStore } from '../stores/daemons'

const agents = useAgentsStore()
const daemons = useDaemonsStore()

const command = ref(localStorage.getItem('agentlet-spawn-command') ?? '')
const cwd = ref(localStorage.getItem('agentlet-spawn-cwd') ?? '')
const autoRestart = ref(localStorage.getItem('agentlet-spawn-autorestart') === 'true')
const showSpawnForm = ref(false)

watch(() => agents.userToken, (token) => {
  if (token) daemons.fetchDaemons(token)
}, { immediate: true })

watch(() => daemons.selectedDaemonId, (daemonId) => {
  if (daemonId && agents.userToken) {
    daemons.fetchDaemonAgents(agents.userToken, daemonId)
  }
})

let pollInterval: ReturnType<typeof setInterval> | null = null
watch(() => agents.userToken, (token) => {
  if (pollInterval) clearInterval(pollInterval)
  if (token) { pollInterval = setInterval(() => daemons.fetchDaemons(token), 5000) }
}, { immediate: true })

// Persist spawn fields on change
watch(command, (v) => localStorage.setItem('agentlet-spawn-command', v))
watch(cwd, (v) => localStorage.setItem('agentlet-spawn-cwd', v))
watch(autoRestart, (v) => localStorage.setItem('agentlet-spawn-autorestart', String(v)))

async function handleSpawn() {
  if (!command.value.trim() || !daemons.selectedDaemonId) return
  const result = await daemons.spawnAgent(agents.userToken, daemons.selectedDaemonId, {
    command: command.value.trim(),
    cwd: cwd.value.trim() || undefined,
    autoRestart: autoRestart.value,
  })
  if (result) {
    // Keep command/cwd in localStorage for quick re-spawn — don't clear them
    showSpawnForm.value = false
    // Refresh daemon agents and global agents list
    if (daemons.selectedDaemonId) {
      daemons.fetchDaemonAgents(agents.userToken, daemons.selectedDaemonId)
    }
    setTimeout(() => agents.fetchSessions(), 1000)
  }
}

async function handleStop(sessionId: string) {
  if (!daemons.selectedDaemonId) return
  const ok = await daemons.stopAgent(agents.userToken, daemons.selectedDaemonId, sessionId)
  if (ok && daemons.selectedDaemonId) {
    daemons.fetchDaemonAgents(agents.userToken, daemons.selectedDaemonId)
    setTimeout(() => agents.fetchSessions(), 1000)
  }
}
</script>

<template>
  <div class="daemon-panel">
    <div class="panel-header">
      <h3>Daemons</h3>
      <span class="count">{{ daemons.daemons.length }}</span>
    </div>

    <div v-if="daemons.daemons.length === 0" class="empty">
      No daemons connected
    </div>

    <div v-else>
      <div class="daemon-list">
        <div
          v-for="daemon in daemons.daemons"
          :key="daemon.daemonId"
          class="daemon-item"
          :class="{ selected: daemons.selectedDaemonId === daemon.daemonId }"
          @click="daemons.selectDaemon(daemon.daemonId)"
        >
          <span class="status-dot" :class="daemon.connected ? 'connected' : 'disconnected'"></span>
          <div class="daemon-info">
            <span class="daemon-id">{{ daemon.daemonId }}</span>
            <span class="daemon-meta" v-if="daemon.machine">
              {{ daemon.machine.hostname }} ({{ daemon.machine.platform }})
            </span>
          </div>
        </div>
      </div>

      <!-- Selected daemon detail -->
      <div v-if="daemons.selectedDaemonId" class="daemon-detail">
        <div class="detail-header">
          <span class="detail-title">Agents on daemon</span>
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
          <div class="form-field checkbox">
            <input type="checkbox" id="auto-restart" v-model="autoRestart" />
            <label for="auto-restart">Auto-restart on crash</label>
          </div>
          <button class="submit-btn" @click="handleSpawn" :disabled="!command.trim() || daemons.spawning">
            {{ daemons.spawning ? 'Spawning...' : 'Spawn' }}
          </button>
          <div v-if="daemons.error" class="error">{{ daemons.error }}</div>
        </div>

        <!-- Agent list on daemon -->
        <div class="daemon-agents">
          <div v-if="daemons.daemonAgents.length === 0" class="empty-agents">
            No agents running on this daemon
          </div>
          <div v-for="agent in daemons.daemonAgents" :key="agent.sessionId" class="agent-row">
            <div class="agent-info">
              <span class="agent-id">{{ agent.sessionId }}</span>
              <span class="agent-cmd">{{ agent.command }}</span>
              <span class="agent-meta">PID: {{ agent.pid }} | {{ agent.cwd }}</span>
            </div>
            <button class="stop-btn" @click="handleStop(agent.sessionId)">Stop</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.daemon-panel { padding: 12px 16px; border-top: 1px solid #e0e0e0; }
.panel-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.panel-header h3 { margin: 0; font-size: 14px; color: #333; }
.count { background: #e0e0e0; color: #555; font-size: 11px; padding: 1px 6px; border-radius: 8px; }
.empty { color: #999; font-size: 13px; font-style: italic; }
.daemon-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.daemon-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid #e0e0e0; border-radius: 4px; cursor: pointer; transition: background 0.1s; }
.daemon-item:hover { background: #f5f5f5; }
.daemon-item.selected { background: #e8f4fd; border-color: #90caf9; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.status-dot.connected { background: #22c55e; }
.status-dot.disconnected { background: #ef4444; }
.daemon-info { display: flex; flex-direction: column; min-width: 0; }
.daemon-id { font-size: 12px; font-family: monospace; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.daemon-meta { font-size: 11px; color: #888; }
.daemon-detail { border-top: 1px solid #eee; padding-top: 10px; }
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
.daemon-agents { display: flex; flex-direction: column; gap: 4px; }
.empty-agents { color: #999; font-size: 12px; font-style: italic; }
.agent-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; background: #fafafa; border: 1px solid #eee; border-radius: 4px; }
.agent-info { display: flex; flex-direction: column; min-width: 0; }
.agent-id { font-size: 11px; font-family: monospace; color: #333; }
.agent-cmd { font-size: 11px; color: #666; }
.agent-meta { font-size: 10px; color: #999; }
.stop-btn { background: #ef4444; color: white; border: none; border-radius: 4px; padding: 3px 10px; font-size: 11px; cursor: pointer; }
.stop-btn:hover { background: #dc2626; }
</style>
