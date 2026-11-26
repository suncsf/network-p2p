<template>
  <teleport to="body">
    <div
      v-if="visible"
      ref="menuRef"
      class="ctx-menu"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      @contextmenu.prevent
    >
      <template v-for="(item, i) in items" :key="i">
        <div v-if="item.divider" class="ctx-divider" />
        <div
          v-else
          class="ctx-item"
          :class="{ danger: item.danger, disabled: item.disabled }"
          @click.stop="select(item)"
        >
          <el-icon v-if="item.icon" class="ctx-icon"><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </div>
      </template>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ContextMenuItem } from './context-menu'

const props = defineProps<{
  visible: boolean
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const menuRef = ref<HTMLElement | null>(null)
const pos = ref({ x: props.x, y: props.y })

// 打开/移动时按菜单实际尺寸夹取位置，避免超出视口
watch(
  () => [props.visible, props.x, props.y] as const,
  async ([v]) => {
    if (!v) return
    pos.value = { x: props.x, y: props.y }
    await nextTick()
    const el = menuRef.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    pos.value = {
      x: Math.max(4, Math.min(props.x, window.innerWidth - rect.width - 8)),
      y: Math.max(4, Math.min(props.y, window.innerHeight - rect.height - 8))
    }
  },
  { immediate: true }
)

function insideMenu(target: EventTarget | null): boolean {
  return !!(menuRef.value && target instanceof Node && menuRef.value.contains(target))
}

function onDocMouseDown(e: MouseEvent): void {
  if (props.visible && !insideMenu(e.target)) emit('close')
}

function onDocContextMenu(e: MouseEvent): void {
  // 行内右键会 preventDefault 并自行重新打开，这里只负责「其他区域右键时关闭」
  if (!props.visible || e.defaultPrevented || insideMenu(e.target)) return
  emit('close')
}

function onKey(e: KeyboardEvent): void {
  if (props.visible && e.key === 'Escape') emit('close')
}

function onScrollOrResize(): void {
  if (props.visible) emit('close')
}

window.addEventListener('mousedown', onDocMouseDown, true)
window.addEventListener('contextmenu', onDocContextMenu, true)
window.addEventListener('keydown', onKey, true)
window.addEventListener('scroll', onScrollOrResize, true)
window.addEventListener('resize', onScrollOrResize)

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('contextmenu', onDocContextMenu, true)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('scroll', onScrollOrResize, true)
  window.removeEventListener('resize', onScrollOrResize)
})

function select(item: ContextMenuItem): void {
  if (item.disabled || item.divider) return
  item.action?.()
  emit('close')
}
</script>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 3000;
  min-width: 150px;
  padding: 4px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.12);
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 4px;
  font-size: 13px;
  color: #303133;
  cursor: pointer;
  user-select: none;
}
.ctx-item:hover {
  background: #f5f7fa;
}
.ctx-item.danger {
  color: #f56c6c;
}
.ctx-item.disabled {
  color: #c0c4cc;
  cursor: not-allowed;
}
.ctx-item.disabled:hover {
  background: transparent;
}
.ctx-icon {
  font-size: 14px;
}
.ctx-divider {
  height: 1px;
  margin: 4px 6px;
  background: #ebeef5;
}
</style>
