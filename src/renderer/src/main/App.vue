<template>
  <el-container class="app-shell">
    <el-aside width="200px" class="sidebar">
      <div class="brand">
        <el-icon :size="22"><Connection /></el-icon>
        <span>V-Lattice</span>
      </div>
      <el-menu :default-active="active" class="menu" @select="onSelect">
        <el-menu-item index="workspace">
          <el-icon><FolderOpened /></el-icon><span>工作区</span>
        </el-menu-item>
        <el-menu-item index="transfers">
          <el-icon><Promotion /></el-icon><span>传输</span>
          <el-badge v-if="pendingCount > 0" :value="pendingCount" class="menu-badge" />
        </el-menu-item>
        <el-menu-item index="server">
          <el-icon><Monitor /></el-icon><span>服务端</span>
        </el-menu-item>
        <el-menu-item index="settings">
          <el-icon><Setting /></el-icon><span>设置</span>
        </el-menu-item>
      </el-menu>
      <div class="status">
        <span class="st-dot" :class="{ active: connCount > 0 }"></span>
        {{ connCount > 0 ? `${connCount} 个连接` : '无连接' }}
      </div>
    </el-aside>

    <el-main class="content">
      <!-- 全部页面 v-show 常驻（相当于 keep-alive 缓存页）：切换菜单不卸载组件，
           保留各自的操作状态（传输记录筛选、滚动位置、表单内容等），仅按需隐藏 -->
      <PageWrapper v-show="active === 'workspace'" page-title="工作区" route-name="workspace">
        <WorkspaceView ref="workspaceRef" />
      </PageWrapper>
      <!-- 传输页独立于连接：待确认请求来自本机服务端（不连接别人也会被推送），传输记录也是全局的 -->
      <PageWrapper v-show="active === 'transfers'" page-title="传输" route-name="transfers">
        <TransfersView :page-active="active === 'transfers'" />
      </PageWrapper>
      <PageWrapper v-show="active === 'server'" page-title="服务端" route-name="server">
        <ServerView :page-active="active === 'server'" @go-settings="active = 'settings'" />
      </PageWrapper>
      <PageWrapper v-show="active === 'settings'" page-title="设置" route-name="settings">
        <SettingsView />
      </PageWrapper>
    </el-main>
  </el-container>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { Connection, FolderOpened, Monitor, Promotion, Setting } from '@element-plus/icons-vue'
import WorkspaceView from './views/WorkspaceView.vue'
import ServerView from './views/ServerView.vue'
import SettingsView from './views/SettingsView.vue'
import TransfersView from './views/TransfersView.vue'
import PageWrapper from '@renderer/components/PageWrapper.vue'
import type { ConnectionInfo } from '@shared/protocol'

const active = ref('workspace')
const connCount = ref(0)
/** 待确认传输数：驱动侧栏角标（decide/超时无事件，轮询内存接口兜底） */
const pendingCount = ref(0)
const workspaceRef = ref<InstanceType<typeof WorkspaceView> | null>(null)
let unsubs: Array<() => void> = []
let pendingTimer: number | undefined

async function refreshPending(): Promise<void> {
  try {
    const list = (await window.api.client.pendingTransfers()) as unknown[]
    pendingCount.value = list.length
  } catch {
    /* 服务端未启动等情况忽略 */
  }
}

function onSelect(index: string): void {
  active.value = index
}

onMounted(() => {
  window.api.client.list().then((list) => (connCount.value = (list as ConnectionInfo[]).length))
  unsubs.push(
    window.api.on('state:connections', (payload) => {
      connCount.value = (payload as ConnectionInfo[]).length
    })
  )
  void refreshPending()
  pendingTimer = window.setInterval(refreshPending, 3000)
  unsubs.push(
    window.api.on('server:event', (ev) => {
      if ((ev as { event?: string }).event === 'transfer:incoming') void refreshPending()
    })
  )
  // 悬浮球右键菜单「传输」等入口的跨页面导航
  unsubs.push(
    window.api.on('nav:goto', (page) => {
      if (typeof page === 'string' && ['workspace', 'transfers', 'server', 'settings'].includes(page)) {
        active.value = page
      }
    })
  )
})

onUnmounted(() => {
  unsubs.forEach((u) => u())
  if (pendingTimer) clearInterval(pendingTimer)
})
</script>

<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
}
</style>

<style scoped>
.app-shell {
  height: 100vh;
}
.sidebar {
  background: #1f2d3d;
  display: flex;
  flex-direction: column;
  color: #fff;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 700;
  padding: 18px 20px;
  letter-spacing: 1px;
}
.menu {
  border: none;
  background: transparent;
  flex: 1;
}
:deep(.el-menu-item) {
  color: #bfcbd9;
}
:deep(.el-menu-item.is-active) {
  color: #fff;
  background: #2b3f56;
}
:deep(.el-menu-item:hover) {
  background: #26384c;
}
.status {
  padding: 12px 20px;
  font-size: 13px;
  color: #bfcbd9;
  display: flex;
  align-items: center;
  gap: 8px;
}
:deep(.menu-badge) {
  margin-left: 8px;
  transform: translateY(-1px);
}
.st-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #909399;
}
.st-dot.active {
  background: #67c23a;
}
.content {
  background: #f5f7fa;
  padding: 16px 20px;
  overflow: auto;
}
</style>
