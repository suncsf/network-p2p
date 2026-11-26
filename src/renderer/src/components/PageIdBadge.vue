<template>
  <span v-if="pageId" class="pid-badge" title="点击复制页面/弹窗标识" @click.stop="copy">
    #{{ pageId }}
  </span>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus'

const props = defineProps<{ pageId: string }>()

async function copy(): Promise<void> {
  const text = `#${props.pageId}`
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 兜底：部分场景 clipboard API 不可用
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  ElMessage.success(`已复制 ${text}`)
}
</script>

<style scoped>
.pid-badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border: 1px solid #d3d8de;
  border-radius: 9px;
  background: #f4f6f8;
  color: #6b7785;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.pid-badge:hover {
  color: #1f2d3d;
  border-color: #9aa7b4;
}
</style>
