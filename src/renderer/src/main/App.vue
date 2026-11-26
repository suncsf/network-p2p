<template>
  <el-container class="app-shell">
    <el-aside width="200px" class="sidebar">
      <div class="brand">
        <el-icon :size="22"><Connection /></el-icon>
        <span>Lattice</span>
      </div>
      <el-menu :default-active="active" class="menu" @select="onSelect">
        <el-menu-item index="workspace">
          <el-icon><FolderOpened /></el-icon><span>工作区</span>
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
      <!-- 工作区 v-show 常驻（相当于 keep-alive 缓存页），服务端/设置 v-if 随切换装卸 -->
      <PageWrapper v-show="active === 'workspace'" page-title="工作区" route-name="workspace">
        <WorkspaceView ref="workspaceRef" />
      </PageWrapper>
      <PageWrapper v-if="active === 'server'" page-title="服务端" route-name="server">
        <ServerView @go-settings="active = 'settings'" />
      </PageWrapper>
      <PageWrapper v-if="active === 'settings'" page-title="设置" route-name="settings">
        <SettingsView />
      </PageWrapper>
    </el-main>
  </el-container>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { Connection, FolderOpened, Monitor, Setting } from '@element-plus/icons-vue'
import WorkspaceView from './views/WorkspaceView.vue'
import ServerView from './views/ServerView.vue'
import SettingsView from './views/SettingsView.vue'
import PageWrapper from '@renderer/components/PageWrapper.vue'
import type { ConnectionInfo } from '@shared/protocol'

const active = ref('workspace')
const connCount = ref(0)
const workspaceRef = ref<InstanceType<typeof WorkspaceView> | null>(null)
let unsubs: Array<() => void> = []

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
})

onUnmounted(() => unsubs.forEach((u) => u()))
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
