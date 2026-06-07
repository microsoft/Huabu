import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface SessionInfo {
  sessionId: string
  displayName: string
  agentletId?: string
  connected: boolean
  command: string
  cwd: string
  supportsLoad: boolean
  supportsResume: boolean
  createdAt: string
  updatedAt: string
}

export const useAgentsStore = defineStore('agents', () => {
  const sessions = ref<SessionInfo[]>([])
  const selectedSessionId = ref<string | null>(localStorage.getItem('agentlet-selected-session') ?? null)
  const loading = ref(false)
  const sessionsLoaded = ref(false)
  const userToken = ref<string>(localStorage.getItem('agentlet-token') ?? '')

  function setToken(token: string) {
    userToken.value = token
    localStorage.setItem('agentlet-token', token)
  }

  async function fetchSessions() {
    if (!userToken.value) return
    loading.value = true
    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${userToken.value}`,
      }
      const res = await fetch('/api/sessions', { headers })
      const data = await res.json()
      sessions.value = data.sessions ?? []
      sessionsLoaded.value = true

      // Auto-select saved session if still available, else first connected
      if (selectedSessionId.value) {
        const saved = sessions.value.find(s => s.sessionId === selectedSessionId.value)
        if (!saved) {
          // Stale selection — clear it, then try to pick an active one
          selectedSessionId.value = null
          localStorage.removeItem('agentlet-selected-session')
          const active = sessions.value.find(s => s.connected)
          if (active) selectSession(active.sessionId)
        }
      } else if (sessions.value.length > 0) {
        const active = sessions.value.find(s => s.connected)
        if (active) selectSession(active.sessionId)
      }
    } catch (e) {
      console.error('Failed to fetch sessions:', e)
    } finally {
      loading.value = false
    }
  }

  function selectSession(sessionId: string) {
    selectedSessionId.value = sessionId
    localStorage.setItem('agentlet-selected-session', sessionId)
  }

  async function updateDisplayName(sessionId: string, displayName: string): Promise<boolean> {
    if (!userToken.value) return false
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${userToken.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ displayName }),
      })
      if (!res.ok) return false
      // Update local state
      const session = sessions.value.find(s => s.sessionId === sessionId)
      if (session) session.displayName = displayName
      return true
    } catch {
      return false
    }
  }

  return { sessions, selectedSessionId, sessionsLoaded, loading, userToken, setToken, fetchSessions, selectSession, updateDisplayName }
})
