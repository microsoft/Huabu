<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useAgentsStore } from './stores/agents'
import { useAgentletsStore } from './stores/agentlets'
import SessionPanel from './components/SessionPanel.vue'
import SessionMeta from './components/SessionMeta.vue'
import ChatView from './components/ChatView.vue'
import TokenPrompt from './components/TokenPrompt.vue'

const agents = useAgentsStore()
const agentlets = useAgentletsStore()

onMounted(() => {
  if (agents.userToken) {
    agents.fetchSessions()
    agentlets.fetchAgentlets(agents.userToken)
  }
})

// Poll for updates when token is set
let pollInterval: ReturnType<typeof setInterval> | null = null
watch(() => agents.userToken, (token) => {
  if (pollInterval) clearInterval(pollInterval)
  if (token) {
    agents.fetchSessions()
    agentlets.fetchAgentlets(token)
    pollInterval = setInterval(() => {
      agents.fetchSessions()
      agentlets.fetchAgentlets(token)
    }, 5000)
  }
}, { immediate: true })
</script>

<template>
  <TokenPrompt v-if="!agents.userToken" />
  <div v-else class="app">
    <SessionPanel />
    <main>
      <SessionMeta />
      <ChatView />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: row;
  height: 100vh;
}
main {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
