<template>
  <div class="workspace">
    <div class="tab-bar-extra">
      <el-tabs
        v-model="activeId"
        type="card"
        class="conn-tabs"
        :closable="true"
        @tab-remove="onClose"
        @tab-change="onSwitch"
      >
        <el-tab-pane
          v-for="c in connections"
          :key="c.id"
          :name="c.id"
          :closable="true"
        >
          <template #label>
            <span class="tab-label" :class="`st-${c.state}`">
              <span class="tab-dot"></span>
              {{ label(c) }}
            </span>
          </template>
        </el-tab-pane>
        <el-tab-pane :name="NEW_TAB" :closable="false">
          <template #label>
            <span class="tab-new" @click.stop="showNew = true"><el-icon><Plus /></el-icon> 新建连接</span>
          </template>
        </el-tab-pane>
      </el-tabs>
    </div>

    <div class="tab-content">
      <SessionView
        v-for="c in connections"
        v-show="activeId === c.id"
        :key="c.id"
        :connection="c"
      />
      <div v-if="connections.length === 0" class="empty-state">
        <el-empty description="还没有任何连接，点击上方“新建连接”开始">
          <el-button type="primary" @click="showNew = true">新建连接</el-button>
        </el-empty>
      </div>
    </div>

    <el-dialog v-model="showNew" width="460px" @closed="resetForm">
      <template #header>
        <div class="dlg-header">
          <span>新建连接</span>
          <PageIdBadge :page-id="newConnPageId" />
        </div>
      </template>
      <el-form :model="form" label-width="88px" @submit.prevent="submit">
        <el-form-item label="IP / 主机">
          <el-input v-model="form.host" placeholder="192.168.1.10" />
        </el-form-item>
        <el-form-item label="端口">
          <el-input-number v-model="form.port" :min="1" :max="65535" controls-position="right" />
        </el-form-item>
        <el-form-item label="账号">
          <el-input v-model="form.username" placeholder="用户名" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" show-password placeholder="密码" />
        </el-form-item>
        <el-form-item v-if="error" label=" ">
          <el-alert :title="error" type="error" show-icon :closable="false" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showNew = false">取消</el-button>
        <el-button type="primary" :loading="loading" @click="submit">连接</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import type { ConnectionInfo } from '@shared/protocol'
import SessionView from './SessionView.vue'
import PageIdBadge from '@renderer/components/PageIdBadge.vue'
import { registerDialog, unregisterDialog } from '@renderer/composables/usePageRegistry'

const NEW_TAB = '__new__'

const connections = ref<ConnectionInfo[]>([])
const activeId = ref('')
const showNew = ref(false)
// 弹窗标识：打开注册、关闭注销（watch 覆盖取消/确定/X/ESC 全部关闭路径）
const newConnPageId = ref('')
watch(showNew, (visible) => {
  if (visible) {
    newConnPageId.value = registerDialog('新建连接', 'workspace::new-connection')
  } else if (newConnPageId.value) {
    unregisterDialog(newConnPageId.value)
    newConnPageId.value = ''
  }
})
const loading = ref(false)
const error = ref('')
const form = reactive({ host: '127.0.0.1', port: 47100, username: '', password: '' })
let unsubs: Array<() => void> = []

function label(c: ConnectionInfo): string {
  return `${c.username || c.host}@${c.host}:${c.port}`
}

function resetForm(): void {
  form.username = ''
  form.password = ''
  error.value = ''
}

async function refresh(): Promise<void> {
  connections.value = (await window.api.client.list()) as ConnectionInfo[]
}

async function submit(): Promise<void> {
  error.value = ''
  if (!form.host || !form.username) {
    error.value = '请填写 IP 与账号'
    return
  }
  loading.value = true
  try {
    const info = (await window.api.client.connect({ ...form })) as ConnectionInfo
    await refresh()
    activeId.value = info.id
    showNew.value = false
    ElMessage.success('连接成功')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function onSwitch(id: string | number): void {
  const s = String(id)
  if (s === NEW_TAB) {
    showNew.value = true
    // 回到之前的有效选项卡
    activeId.value = connections.value[0]?.id ?? ''
    return
  }
  activeId.value = s
}

async function onClose(id: string | number): Promise<void> {
  const cid = String(id)
  if (!cid) return
  try {
    await ElMessageBox.confirm('断开并关闭此连接？', '确认', { type: 'warning' })
  } catch {
    return
  }
  await window.api.client.disconnect(cid)
  await refresh()
  if (activeId.value === cid) {
    activeId.value = connections.value[0]?.id ?? ''
  }
}

onMounted(async () => {
  await refresh()
  if (connections.value.length > 0) activeId.value = connections.value[0].id
  unsubs.push(
    window.api.on('state:connections', (payload) => {
      const list = payload as ConnectionInfo[]
      // 保留 activeId 与本地顺序
      connections.value = list
      if (!list.some((c) => c.id === activeId.value)) {
        activeId.value = list[0]?.id ?? ''
      }
    })
  )
})

onUnmounted(() => unsubs.forEach((u) => u()))

defineExpose({ openNew: () => (showNew.value = true) })
</script>

<style scoped>
.workspace {
  height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
}
.conn-tabs {
  width: 100%;
}
:deep(.el-tabs__header) {
  margin-bottom: 12px;
}
.tab-content {
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tab-new {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #409eff;
}
.dlg-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tab-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #909399;
}
.st-connected .tab-dot {
  background: #67c23a;
}
.st-connecting .tab-dot,
.st-reconnecting .tab-dot {
  background: #e6a23c;
}
.st-error .tab-dot {
  background: #f56c6c;
}
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}
</style>
