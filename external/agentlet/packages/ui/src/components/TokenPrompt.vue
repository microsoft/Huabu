<script setup lang="ts">
import { ref } from 'vue'
import { useAgentsStore } from '../stores/agents'

const agents = useAgentsStore()
const tokenInput = ref(agents.userToken)

function submit() {
  const token = tokenInput.value.trim()
  if (token) {
    agents.setToken(token)
    agents.fetchSessions()
  }
}
</script>

<template>
  <div class="token-prompt">
    <div class="card">
      <h2>🔑 Enter your token</h2>
      <p>Enter the access token provided by your admin to view your agents.</p>
      <form @submit.prevent="submit">
        <input
          v-model="tokenInput"
          type="password"
          placeholder="tok_..."
          autofocus
        />
        <button type="submit" :disabled="!tokenInput.trim()">Connect</button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.token-prompt {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: #f0f2f5;
}
.card {
  background: white;
  padding: 40px;
  border-radius: 12px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
  max-width: 400px;
  width: 100%;
}
.card h2 {
  margin: 0 0 8px 0;
  font-size: 20px;
}
.card p {
  margin: 0 0 20px 0;
  color: #666;
  font-size: 14px;
}
form {
  display: flex;
  gap: 8px;
}
input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: 14px;
  outline: none;
}
input:focus {
  border-color: #2196f3;
}
button {
  padding: 10px 20px;
  background: #2196f3;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
}
button:disabled {
  background: #ccc;
  cursor: not-allowed;
}
button:not(:disabled):hover {
  background: #1976d2;
}
</style>
