<template>
  <div
    class="floater"
    :class="[stateClass, { alert }]"
    @mousedown="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
    @contextmenu.prevent="onContextMenu"
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
  // 仅展开主界面，悬浮球保持常驻（设计为始终置顶；此前点击后隐藏悬浮球且无人再唤起，表现为"点一下就没了"）
  window.api.window.openMain()
}

// 手动拖动：窗口整体 -webkit-app-region: no-drag 时系统拖动不生效，
// 且 drag 区域会吞掉 click 事件，故用 mousemove + IPC 移动窗口。
// 拖动距离超过阈值视为拖动，否则 mouseup 时按点击展开主界面。
const DRAG_THRESHOLD = 4
let dragging = false
let moved = false
let dist = 0
let lastX = 0
let lastY = 0

function onMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return
  dragging = true
  moved = false
  dist = 0
  lastX = e.screenX
  lastY = e.screenY
}

function onMouseMove(e: MouseEvent): void {
  if (!dragging) return
  const dx = e.screenX - lastX
  const dy = e.screenY - lastY
  lastX = e.screenX
  lastY = e.screenY
  if (dx === 0 && dy === 0) return
  dist += Math.abs(dx) + Math.abs(dy)
  if (dist <= DRAG_THRESHOLD && !moved) return
  moved = true
  window.api.window.moveFloaterBy(Math.round(dx), Math.round(dy))
}

function onMouseUp(): void {
  if (!dragging) return
  dragging = false
  if (!moved) openMain()
}

/** 右键弹出原生菜单（打开界面/传输/退出），由主进程渲染 */
function onContextMenu(): void {
  void window.api.window.floaterMenu()
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
  -webkit-app-region: no-drag;
}

.floater {
  position: relative;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
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
