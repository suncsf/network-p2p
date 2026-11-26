import type { Component } from 'vue'

/** 右键菜单项；divider 为 true 时渲染分隔线（其余字段忽略） */
export interface ContextMenuItem {
  label?: string
  icon?: Component
  danger?: boolean
  disabled?: boolean
  divider?: boolean
  action?: () => void
}
