<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAgentsStore } from '../stores/agents'
import { useAgentletsStore } from '../stores/agentlets'

const agents = useAgentsStore()
const agentlets = useAgentletsStore()

const selectedSession = computed(() => {
  if (!agents.selectedSessionId) return null
  return agents.sessions.find(s => s.sessionId === agents.selectedSessionId) ?? null
})

const editing = ref(false)
const editValue = ref('')

function startEdit() {
  if (!selectedSession.value) return
  editValue.value = selectedSession.value.displayName
  editing.value = true
}

async function saveEdit() {
  if (!selectedSession.value || !editValue.value.trim()) return
  const ok = await agents.updateDisplayName(selectedSession.value.sessionId, editValue.value.trim())
  if (ok) editing.value = false
}

function cancelEdit() {
  editing.value = false
}

function onEditKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); saveEdit() }
  if (e.key === 'Escape') cancelEdit()
}

// Reset edit state when session changes
watch(() => agents.selectedSessionId, () => { editing.value = false })

async function handleStop() {
  const s = selectedSession.value
  if (!s?.agentletId) return
  const ok = await agentlets.stopAgent(agents.userToken, s.agentletId, s.sessionId)
  if (ok) setTimeout(() => agents.fetchSessions(), 1000)
}

async function handleResume() {
  const s = selectedSession.value
  if (!s?.agentletId) return
  const result = await agentlets.resumeSession(
    agents.userToken, s.agentletId, s.sessionId, s.command, s.cwd || undefined
  )
  if (result) setTimeout(() => agents.fetchSessions(), 1000)
}

const copied = ref(false)
function copySessionId() {
  if (!selectedSession.value) return
  navigator.clipboard.writeText(selectedSession.value.sessionId)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString()
}

function shortId(id: string): string {
  if (!id) return '—'
  if (id.length <= 20) return id
  return id.slice(0, 8) + '…' + id.slice(-8)
}
</script>

<template>
  <div v-if="selectedSession" class="session-meta">
    <div class="meta-row">
      <template v-if="editing">
        <input
          class="edit-input"
          v-model="editValue"
          @keydown="onEditKeyDown"
          @blur="cancelEdit"
          autofocus
        />
      </template>
      <template v-else>
        <span class="display-name" @dblclick="startEdit" title="Double-click to rename">
          {{ selectedSession.displayName || shortId(selectedSession.sessionId) }}
        </span>
        <button class="edit-btn" @click="startEdit" title="Rename">✏️</button>
      </template>
      <span class="status-badge" :class="selectedSession.connected ? 'online' : 'offline'">
        {{ selectedSession.connected ? 'connected' : 'disconnected' }}
      </span>
      <div class="action-btns" v-if="selectedSession.agentletId">
        <button
          v-if="selectedSession.connected"
          class="action-btn stop"
          @click="handleStop"
          title="Stop this session"
        >⏹ Stop</button>
        <button
          v-else
          class="action-btn resume"
          @click="handleResume"
          :disabled="agentlets.spawning"
          title="Resume this session"
        >{{ agentlets.spawning ? '…' : '▶ Resume' }}</button>
      </div>
    </div>
    <div v-if="agentlets.error" class="meta-error">{{ agentlets.error }}</div>
    <div class="meta-details">
      <div class="meta-item">
        <span class="meta-label">ID</span>
        <span class="meta-value mono" :title="selectedSession.sessionId">{{ shortId(selectedSession.sessionId) }}</span>
        <button class="copy-btn" @click="copySessionId" :title="copied ? 'Copied!' : 'Copy session ID'">{{ copied ? '✓' : '📋' }}</button>
      </div>
      <div class="meta-item" v-if="selectedSession.command">
        <span class="meta-label">Command</span>
        <span class="meta-value mono">{{ selectedSession.command }}</span>
      </div>
      <div class="meta-item" v-if="selectedSession.cwd">
        <span class="meta-label">CWD</span>
        <span class="meta-value mono">{{ selectedSession.cwd }}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Created</span>
        <span class="meta-value">{{ formatDate(selectedSession.createdAt) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-meta {
  padding: 10px 16px;
  border-bottom: 1px solid #e0e0e0;
  background: #fafafa;
  flex-shrink: 0;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.display-name {
  font-size: 14px;
  font-weight: 600;
  color: #1a1a1a;
  cursor: default;
}
.edit-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
  opacity: 0.4;
  transition: opacity 0.15s;
}
.edit-btn:hover { opacity: 1; }
.edit-input {
  font-size: 14px;
  font-weight: 600;
  padding: 1px 6px;
  border: 1px solid #2196f3;
  border-radius: 4px;
  outline: none;
  flex: 1;
  max-width: 300px;
}
.meta-details {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin-top: 6px;
}
.meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
}
.meta-label {
  font-size: 11px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
}
.meta-value {
  font-size: 12px;
  color: #333;
}
.meta-value.mono {
  font-family: monospace;
  font-size: 11px;
}
.status-badge {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 8px;
  font-weight: 600;
  margin-left: auto;
}
.status-badge.online {
  background: #dcfce7;
  color: #166534;
}
.status-badge.offline {
  background: #f3f4f6;
  color: #6b7280;
}
.action-btns {
  display: flex;
  gap: 6px;
  margin-left: 8px;
}
.action-btn {
  font-size: 11px;
  padding: 2px 8px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 600;
}
.action-btn.stop {
  background: #fee2e2;
  color: #991b1b;
}
.action-btn.stop:hover {
  background: #fecaca;
}
.action-btn.resume {
  background: #dcfce7;
  color: #166534;
}
.action-btn.resume:hover {
  background: #bbf7d0;
}
.action-btn:disabled {
  background: #e5e7eb;
  color: #9ca3af;
  cursor: not-allowed;
}
.meta-error {
  color: #ef4444;
  font-size: 11px;
  margin-top: 4px;
}
.copy-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 11px;
  padding: 0 2px;
  opacity: 0.4;
  transition: opacity 0.15s;
  line-height: 1;
}
.copy-btn:hover { opacity: 1; }
</style>
