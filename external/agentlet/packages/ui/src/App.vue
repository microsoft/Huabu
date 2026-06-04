<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useAgentsStore } from './stores/agents'
import AgentSelector from './components/AgentSelector.vue'
import ChatView from './components/ChatView.vue'
import DaemonPanel from './components/DaemonPanel.vue'
import TokenPrompt from './components/TokenPrompt.vue'

const agents = useAgentsStore()

onMounted(() => {
  if (agents.userToken) {
    agents.fetchAgents()
  }
})

// Poll for agent updates when token is set
let pollInterval: ReturnType<typeof setInterval> | null = null
watch(() => agents.userToken, (token) => {
  if (pollInterval) clearInterval(pollInterval)
  if (token) {
    pollInterval = setInterval(() => agents.fetchAgents(), 5000)
  }
}, { immediate: true })
</script>

<template>
  <TokenPrompt v-if="!agents.userToken" />
  <div v-else class="app">
    <header>
      <div class="header-row">
        <h1>Agentlet</h1>
        <button class="logout-btn" @click="agents.setToken('')">🔓 Logout</button>
      </div>
      <AgentSelector />
      <DaemonPanel />
    </header>
    <main>
      <ChatView />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
header {
  flex-shrink: 0;
}
.header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px 0;
}
.header-row h1 {
  font-size: 18px;
  color: #1a1a1a;
  margin: 0;
}
.logout-btn {
  background: none;
  border: 1px solid #ccc;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  color: #666;
}
.logout-btn:hover {
  background: #f5f5f5;
}
main {
  flex: 1;
  overflow: hidden;
}
</style>
