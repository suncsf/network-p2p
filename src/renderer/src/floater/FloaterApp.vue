<template>
  <div
    class="floater"
    :class="[stateClass, { alert }]"
    @click="openMain"
    @dblclick="openMain"
    @contextmenu.prevent
  >
    <div class="ring" :style="ringStyle"></div>
    <div class="core">
      <span class="dot"></span>
      <span v-if="progress > 0" class="pct">{{ Math.round(progress * 100) }}%</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

const state = ref<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('idle')
const progress = ref(0)
const alert = ref(false)
let unsubs: Array<() => void> = []

const stateClass = computed(() => `state-${state.value}`)

const ringStyle = computed(() => {
  const deg = Math.max(0, Math.min(1, progress.value)) * 360
  return {
    background: `conic-gradient(#409eff ${deg}deg, rgba(255,255,255,0.12) ${deg}deg)`
  }
})

function openMain(): void {
  window.api.window.openMain()
  window.api.window.closeFloater()
}

onMounted(() => {
  unsubs.push(
    window.api.on('state:connection', (payload) => {
      const p = payload as { state: typeof state.value }
      state.value = p.state
    }),
    window.api.on('floater:progress', (payload) => {
      progress.value = (payload as { progress: number }).progress
    }),
    window.api.on('floater:alert', () => {
      alert.value = true
      setTimeout(() => (alert.value = false), 5000)
    })
  )
  window.api.client.state().then((s) => (state.value = s as typeof state.value))
})

onUnmounted(() => unsubs.forEach((u) => u()))
</script>

<style>
html,
body,
#app {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
  user-select: none;
  -webkit-app-region: drag;
}

.floater {
  position: relative;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  padding: 3px;
  mask: radial-gradient(farthest-side, transparent calc(100% - 6px), #000 calc(100% - 5px));
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 6px), #000 calc(100% - 5px));
  opacity: 0.35;
  transition: opacity 0.3s;
}

.state-connecting .ring,
.state-connected .ring {
  opacity: 1;
}

.core {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, #5b6b7c, #2c3e50);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  transition: background 0.3s;
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #909399;
}

.state-connecting .dot {
  background: #409eff;
  animation: pulse 1s infinite;
}

.state-connected .dot {
  background: #67c23a;
}

.state-reconnecting .dot {
  background: #e6a23c;
  animation: pulse 1s infinite;
}

.state-error .dot {
  background: #f56c6c;
}

.pct {
  position: absolute;
  font-size: 11px;
  color: #fff;
  font-weight: 600;
}

.alert {
  animation: shake 0.6s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-3px);
  }
  75% {
    transform: translateX(3px);
  }
}
</style>
