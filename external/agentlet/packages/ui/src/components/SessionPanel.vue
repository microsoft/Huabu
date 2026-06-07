<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAgentsStore, type SessionInfo } from '../stores/agents'
import { useAgentletsStore, type AgentletInfo } from '../stores/agentlets'
import { useSessionStore } from '../stores/session'

const agents = useAgentsStore()
const agentlets = useAgentletsStore()
const session = useSessionStore()

// ── Spawn form state ──────────────────────────────────────────────────────────
const spawnTargetId = ref<string | null>(null)
const spawnSessionId = ref('')
const command = ref(localStorage.getItem('agentlet-spawn-command') ?? '')
const cwd = ref(localStorage.getItem('agentlet-spawn-cwd') ?? '')
const autoRestart = ref(localStorage.getItem('agentlet-spawn-autorestart') === 'true')
watch(command, (v) => localStorage.setItem('agentlet-spawn-command', v))
watch(cwd, (v) => localStorage.setItem('agentlet-spawn-cwd', v))
watch(autoRestart, (v) => localStorage.setItem('agentlet-spawn-autorestart', String(v)))

// ── Collapsed state ───────────────────────────────────────────────────────────
const collapsedGroups = ref<Set<string>>(new Set())
function toggleGroup(id: string) {
  if (collapsedGroups.value.has(id)) {
    collapsedGroups.value.delete(id)
  } else {
    collapsedGroups.value.add(id)
  }
}

// ── Grouped sessions ─────────────────────────────────────────────────────────
interface AgentletGroup {
  agentlet: AgentletInfo
  sessions: SessionInfo[]
}

const agentletGroups = computed<AgentletGroup[]>(() => {
  return agentlets.agentlets.map(a => ({
    agentlet: a,
    sessions: agents.sessions.filter(s => s.agentletId === a.agentletId),
  }))
})

const standaloneSessions = computed<SessionInfo[]>(() => {
  const agentletIds = new Set(agentlets.agentlets.map(a => a.agentletId))
  return agents.sessions.filter(s => !s.agentletId || !agentletIds.has(s.agentletId))
})

// ── Selection ─────────────────────────────────────────────────────────────────
function selectSession(sessionId: string) {
  agents.selectSession(sessionId)
}

// Auto-connect when selection changes, but only after sessions have been fetched
watch([() => agents.selectedSessionId, () => agents.sessionsLoaded], ([sessionId, loaded]) => {
  if (sessionId && loaded) {
    session.connectToSession(sessionId, agents.userToken || undefined)
  } else if (!sessionId) {
    session.disconnect()
  }
}, { immediate: true })

// Auto-select first connected session on initial load
watch(() => agents.sessions, (sessions) => {
  if (!agents.selectedSessionId && sessions.length > 0) {
    const active = sessions.find(s => s.connected)
    if (active) selectSession(active.sessionId)
  }
}, { immediate: true })

// ── Spawn / Stop ──────────────────────────────────────────────────────────────
function toggleSpawnForm(agentletId: string) {
  spawnTargetId.value = spawnTargetId.value === agentletId ? null : agentletId
}

async function handleSpawn(agentletId: string) {
  if (!command.value.trim()) return
  const sid = spawnSessionId.value.trim() || undefined
  let result
  if (sid) {
    result = await agentlets.resumeSession(
      agents.userToken, agentletId, sid, command.value.trim(), cwd.value.trim() || undefined
    )
  } else {
    result = await agentlets.spawnAgent(agents.userToken, agentletId, {
      command: command.value.trim(),
      cwd: cwd.value.trim() || undefined,
      autoRestart: autoRestart.value,
    })
  }
  if (result) {
    spawnTargetId.value = null
    spawnSessionId.value = ''
    setTimeout(() => agents.fetchSessions(), 1000)
  }
}

async function handleStop(agentletId: string, sessionId: string) {
  const ok = await agentlets.stopAgent(agents.userToken, agentletId, sessionId)
  if (ok) {
    setTimeout(() => agents.fetchSessions(), 1000)
  }
}

async function handleResume(agentletId: string, s: SessionInfo) {
  const result = await agentlets.resumeSession(
    agents.userToken, agentletId, s.sessionId, s.command, s.cwd || undefined
  )
  if (result) {
    setTimeout(() => agents.fetchSessions(), 1000)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function shortId(id: string): string {
  if (id.length <= 16) return id
  return id.slice(0, 6) + '…' + id.slice(-6)
}

function sessionLabel(s: SessionInfo): string {
  if (s.displayName && s.displayName !== s.sessionId) return s.displayName
  return shortId(s.sessionId)
}

function statusClass(s: SessionInfo): string {
  return s.connected ? 'online' : 'offline'
}

function statusLabel(s: SessionInfo): string {
  return s.connected ? 'active' : 'disconnected'
}
</script>

<template>
  <aside class="session-panel">
    <div class="panel-header">
      <h2>Sessions</h2>
      <button class="logout-btn" @click="agents.setToken('')" title="Logout">🔓</button>
    </div>

    <div class="panel-body">
      <!-- Agentlet groups -->
      <div v-for="group in agentletGroups" :key="group.agentlet.agentletId" class="group">
        <div
          class="group-header"
          @click="toggleGroup(group.agentlet.agentletId)"
        >
          <span class="collapse-icon">{{ collapsedGroups.has(group.agentlet.agentletId) ? '▶' : '▼' }}</span>
          <span class="dot" :class="group.agentlet.connected ? 'connected' : 'disconnected'"></span>
          <span class="group-label" :title="group.agentlet.agentletId">
            {{ group.agentlet.machine?.hostname ?? shortId(group.agentlet.agentletId) }}
          </span>
          <span class="session-count">{{ group.sessions.length }}</span>
          <button
            class="icon-btn spawn-icon"
            @click.stop="toggleSpawnForm(group.agentlet.agentletId)"
            title="Spawn agent"
          >+</button>
        </div>

        <div v-if="!collapsedGroups.has(group.agentlet.agentletId)">
          <!-- Spawn form -->
          <div v-if="spawnTargetId === group.agentlet.agentletId" class="spawn-form">
            <input v-model="command" placeholder="Agent command" class="spawn-input" />
            <input v-model="cwd" placeholder="Working directory (optional)" class="spawn-input" />
            <input v-model="spawnSessionId" placeholder="Session ID (optional, for resume)" class="spawn-input" />
            <div class="spawn-row">
              <label class="checkbox-label">
                <input type="checkbox" v-model="autoRestart" /> Auto-restart
              </label>
              <button class="spawn-btn" @click="handleSpawn(group.agentlet.agentletId)" :disabled="!command.trim() || agentlets.spawning">
                {{ agentlets.spawning ? '…' : (spawnSessionId.trim() ? 'Resume' : 'Spawn') }}
              </button>
            </div>
            <div v-if="agentlets.error" class="error">{{ agentlets.error }}</div>
          </div>

          <!-- Sessions under this agentlet -->
          <div
            v-for="s in group.sessions"
            :key="s.sessionId"
            class="session-item"
            :class="{ selected: agents.selectedSessionId === s.sessionId }"
            @click="selectSession(s.sessionId)"
          >
            <span class="dot" :class="statusClass(s)"></span>
            <span class="session-label" :title="s.sessionId">{{ sessionLabel(s) }}</span>
            <span class="session-status">{{ statusLabel(s) }}</span>
            <button
              v-if="!s.connected"
              class="icon-btn resume-icon"
              @click.stop="handleResume(group.agentlet.agentletId, s)"
              title="Resume"
            >▶</button>
            <button
              v-if="s.connected"
              class="icon-btn stop-icon"
              @click.stop="handleStop(group.agentlet.agentletId, s.sessionId)"
              title="Stop"
            >✕</button>
          </div>

          <div v-if="group.sessions.length === 0" class="empty-hint">No sessions</div>
        </div>
      </div>

      <!-- Standalone sessions (self-spawned, no parent agentlet) -->
      <div v-if="standaloneSessions.length > 0" class="group">
        <div class="group-header" @click="toggleGroup('__standalone__')">
          <span class="collapse-icon">{{ collapsedGroups.has('__standalone__') ? '▶' : '▼' }}</span>
          <span class="group-label">Direct</span>
          <span class="session-count">{{ standaloneSessions.length }}</span>
        </div>
        <div v-if="!collapsedGroups.has('__standalone__')">
          <div
            v-for="s in standaloneSessions"
            :key="s.sessionId"
            class="session-item"
            :class="{ selected: agents.selectedSessionId === s.sessionId }"
            @click="selectSession(s.sessionId)"
          >
            <span class="dot" :class="statusClass(s)"></span>
            <span class="session-label" :title="s.sessionId">{{ sessionLabel(s) }}</span>
            <span class="session-status">{{ statusLabel(s) }}</span>
          </div>
        </div>
      </div>

      <div v-if="agentletGroups.length === 0 && standaloneSessions.length === 0" class="empty-panel">
        No sessions yet
      </div>
    </div>
  </aside>
</template>

<style scoped>
.session-panel {
  width: 260px;
  min-width: 200px;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #e0e0e0;
  background: #f8f9fa;
  height: 100%;
  overflow: hidden;
}
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 8px;
  border-bottom: 1px solid #e0e0e0;
  flex-shrink: 0;
}
.panel-header h2 {
  margin: 0;
  font-size: 15px;
  color: #1a1a1a;
}
.logout-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  padding: 2px 4px;
  color: #888;
}
.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}

/* Groups */
.group { margin-bottom: 2px; }
.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: #444;
  user-select: none;
}
.group-header:hover { background: #eef0f2; }
.collapse-icon { font-size: 10px; width: 12px; color: #999; }
.group-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-count {
  background: #dfe3e7;
  color: #555;
  font-size: 10px;
  padding: 0 5px;
  border-radius: 8px;
  font-weight: normal;
}

/* Session items */
.session-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px 5px 30px;
  cursor: pointer;
  font-size: 12px;
  color: #555;
}
.session-item:hover { background: #eef0f2; }
.session-item.selected { background: #dbeafe; }
.session-label {
  flex: 1;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-status {
  font-size: 10px;
  color: #999;
  flex-shrink: 0;
}

/* Status dots */
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.connected, .dot.online { background: #22c55e; }
.dot.disconnected, .dot.offline { background: #ccc; }
.dot.suspended { background: #f59e0b; }

/* Icon buttons */
.icon-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  padding: 0 3px;
  color: #999;
  line-height: 1;
}
.icon-btn:hover { color: #333; }
.stop-icon { font-size: 11px; visibility: hidden; }
.session-item:hover .stop-icon { visibility: visible; }
.stop-icon:hover { color: #ef4444 !important; }
.resume-icon { font-size: 11px; visibility: hidden; color: #22c55e; }
.session-item:hover .resume-icon { visibility: visible; }
.resume-icon:hover { color: #16a34a !important; }
.spawn-icon { font-size: 16px; font-weight: bold; }
.spawn-icon:hover { color: #2196f3 !important; }

/* Spawn form */
.spawn-form {
  padding: 8px 12px 8px 30px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.spawn-input {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid #ccc;
  border-radius: 3px;
  font-size: 11px;
  font-family: monospace;
  box-sizing: border-box;
}
.spawn-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.checkbox-label {
  font-size: 11px;
  color: #666;
  display: flex;
  align-items: center;
  gap: 4px;
}
.spawn-btn {
  background: #2196f3;
  color: white;
  border: none;
  border-radius: 3px;
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
}
.spawn-btn:hover { background: #1976d2; }
.spawn-btn:disabled { background: #ccc; cursor: not-allowed; }
.error { color: #ef4444; font-size: 11px; }

/* Empty states */
.empty-hint {
  padding: 4px 12px 4px 30px;
  font-size: 11px;
  color: #bbb;
  font-style: italic;
}
.empty-panel {
  padding: 20px 14px;
  text-align: center;
  color: #999;
  font-size: 13px;
}
</style>
