import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface AgentletInfo {
  agentletId: string
  connected: boolean
  machine?: { hostname: string; platform: string }
  capabilities: { autoRestart: boolean; bufferLimit: number; maxAgents?: number }
  connectedAt: string | null
}

export interface AgentletSession {
  sessionId: string
  command: string
  pid: number
  cwd: string
  status: 'running' | 'starting'
}

export const useAgentletsStore = defineStore('agentlets', () => {
  const agentlets = ref<AgentletInfo[]>([])
  const selectedAgentletId = ref<string | null>(null)
  const agentletSessions = ref<AgentletSession[]>([])
  const loading = ref(false)
  const spawning = ref(false)
  const error = ref<string | null>(null)

  async function fetchAgentlets(token: string) {
    if (!token) return
    loading.value = true
    error.value = null
    try {
      const headers: Record<string, string> = { 'Authorization': `Bearer ${token}` }
      const res = await fetch('/api/agentlets', { headers })
      const data = await res.json()
      agentlets.value = data.agentlets ?? []
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch agentlets'
    } finally {
      loading.value = false
    }
  }

  async function fetchAgentletSessions(token: string, agentletId: string) {
    if (!token || !agentletId) return
    try {
      const headers: Record<string, string> = { 'Authorization': `Bearer ${token}` }
      const res = await fetch(`/api/agentlets/${encodeURIComponent(agentletId)}/sessions`, { headers })
      const data = await res.json()
      agentletSessions.value = data.sessions ?? []
    } catch (e) {
      console.error('Failed to fetch agentlet sessions:', e)
    }
  }

  async function spawnAgent(token: string, agentletId: string, params: { command: string; cwd?: string; env?: Record<string, string>; autoRestart?: boolean }) {
    if (!token || !agentletId) return null
    spawning.value = true
    error.value = null
    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
      const body = {
        appId: 'ui',
        sessionSpec: {
          command: params.command,
          cwd: params.cwd,
          env: params.env,
          autoRestart: params.autoRestart,
        },
      }
      const res = await fetch(`/api/agentlets/${encodeURIComponent(agentletId)}/spawn`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        error.value = data.error ?? 'Spawn failed'
        return null
      }
      return data as { sessionId: string; pid: number }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Spawn failed'
      return null
    } finally {
      spawning.value = false
    }
  }

  async function stopAgent(token: string, agentletId: string, sessionId: string) {
    if (!token || !agentletId || !sessionId) return false
    error.value = null
    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
      const res = await fetch(`/api/agentlets/${encodeURIComponent(agentletId)}/stop`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId }),
      })
      const data = await res.json()
      if (!res.ok) {
        error.value = data.error ?? 'Stop failed'
        return false
      }
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Stop failed'
      return false
    }
  }

  async function resumeSession(token: string, agentletId: string, sessionId: string, command: string, cwd?: string) {
    if (!token || !agentletId || !sessionId) return null
    spawning.value = true
    error.value = null
    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
      const body = {
        appId: 'ui',
        sessionId,
        sessionSpec: { command, cwd },
      }
      const res = await fetch(`/api/agentlets/${encodeURIComponent(agentletId)}/spawn`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        error.value = data.error ?? 'Resume failed'
        return null
      }
      return data as { sessionId: string; pid: number }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Resume failed'
      return null
    } finally {
      spawning.value = false
    }
  }

  function selectAgentlet(agentletId: string) {
    selectedAgentletId.value = agentletId
  }

  return { agentlets, selectedAgentletId, agentletSessions, loading, spawning, error, fetchAgentlets, fetchAgentletSessions, spawnAgent, stopAgent, resumeSession, selectAgentlet }
})
