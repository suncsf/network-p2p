<template>
  <div class="page-wrapper">
    <slot />
    <PageIdBadge class="page-badge" :page-id="pageId" />
  </div>
</template>

<script setup lang="ts">
import PageIdBadge from '@renderer/components/PageIdBadge.vue'
import { usePageId } from '@renderer/composables/usePageRegistry'

/**
 * 页面统一包装器：自动注册页面标识 + 左下角固定渲染徽章。
 * 仅由布局层（App.vue）统一使用，页面组件内禁止再包一层，
 * 否则两个徽章 fixed 同坐标叠印、ID 文字重影，且注册表出现同页两条。
 */
const props = defineProps<{ pageTitle: string; routeName: string }>()

const pageId = usePageId(props.pageTitle, { type: 'page', routeName: props.routeName })
</script>

<style scoped>
.page-wrapper {
  height: 100%;
}
.page-badge {
  position: fixed;
  bottom: 16px;
  /* 228 = 200px 侧边栏 + 28px 偏移 */
  left: 228px;
  z-index: 100;
}
</style>
