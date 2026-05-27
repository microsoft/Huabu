import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface AgentInfo {
  agentId: string
  status: 'connected' | 'disconnected'
  agentInfo: { command: string; pid: number }
  machine?: { hostname: string; platform: string }
  metadata: Record<string, unknown>
  connectedAt: string
}

export const useAgentsStore = defineStore('agents', () => {
  const agents = ref<AgentInfo[]>([])
  const selectedAgentId = ref<string | null>(null)
  const loading = ref(false)
  const userToken = ref<string>(localStorage.getItem('agentlet-token') ?? '')

  function setToken(token: string) {
    userToken.value = token
    localStorage.setItem('agentlet-token', token)
  }

  async function fetchAgents() {
    if (!userToken.value) return
    loading.value = true
    try {
      const headers: Record<string, string> = {}
      if (userToken.value) {
        headers['Authorization'] = `Bearer ${userToken.value}`
      }
      const res = await fetch('/api/agents', { headers })
      const data = await res.json()
      agents.value = data.agents ?? []

      // Auto-select first connected agent if none selected
      if (!selectedAgentId.value && agents.value.length > 0) {
        const connected = agents.value.find(a => a.status === 'connected')
        if (connected) {
          selectedAgentId.value = connected.agentId
        }
      }
    } catch (e) {
      console.error('Failed to fetch agents:', e)
    } finally {
      loading.value = false
    }
  }

  function selectAgent(agentId: string) {
    selectedAgentId.value = agentId
  }

  return { agents, selectedAgentId, loading, userToken, setToken, fetchAgents, selectAgent }
})
