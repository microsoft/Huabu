import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface DaemonInfo {
  daemonId: string
  status: 'connected' | 'disconnected'
  machine?: { hostname: string; platform: string }
  capabilities: { autoRestart: boolean; bufferLimit: number; maxAgents?: number }
  metadata: Record<string, unknown>
  connectedAt: string
}

export interface DaemonAgent {
  agentId: string
  command: string
  pid: number
  cwd: string
  status: 'running' | 'starting'
}

export const useDaemonsStore = defineStore('daemons', () => {
  const daemons = ref<DaemonInfo[]>([])
  const selectedDaemonId = ref<string | null>(null)
  const daemonAgents = ref<DaemonAgent[]>([])
  const loading = ref(false)
  const spawning = ref(false)
  const error = ref<string | null>(null)

  async function fetchDaemons(token: string) {
    if (!token) return
    loading.value = true
    error.value = null
    try {
      const headers: Record<string, string> = { 'Authorization': `Bearer ${token}` }
      const res = await fetch('/api/daemons', { headers })
      const data = await res.json()
      daemons.value = data.daemons ?? []
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch daemons'
    } finally {
      loading.value = false
    }
  }

  async function fetchDaemonAgents(token: string, daemonId: string) {
    if (!token || !daemonId) return
    try {
      const headers: Record<string, string> = { 'Authorization': `Bearer ${token}` }
      const res = await fetch(`/api/daemons/${encodeURIComponent(daemonId)}/agents`, { headers })
      const data = await res.json()
      daemonAgents.value = data.agents ?? []
    } catch (e) {
      console.error('Failed to fetch daemon agents:', e)
    }
  }

  async function spawnAgent(token: string, daemonId: string, params: { command: string; cwd?: string; env?: Record<string, string>; autoRestart?: boolean }) {
    if (!token || !daemonId) return null
    spawning.value = true
    error.value = null
    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
      const res = await fetch(`/api/daemons/${encodeURIComponent(daemonId)}/spawn`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      })
      const data = await res.json()
      if (!res.ok) {
        error.value = data.error ?? 'Spawn failed'
        return null
      }
      return data as { agentId: string; pid: number }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Spawn failed'
      return null
    } finally {
      spawning.value = false
    }
  }

  async function stopAgent(token: string, daemonId: string, agentId: string) {
    if (!token || !daemonId || !agentId) return false
    error.value = null
    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
      const res = await fetch(`/api/daemons/${encodeURIComponent(daemonId)}/stop`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ agentId }),
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

  function selectDaemon(daemonId: string) {
    selectedDaemonId.value = daemonId
  }

  return { daemons, selectedDaemonId, daemonAgents, loading, spawning, error, fetchDaemons, fetchDaemonAgents, spawnAgent, stopAgent, selectDaemon }
})
