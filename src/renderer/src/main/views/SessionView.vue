<template>
  <div class="session">
    <el-alert
      v-if="connection.state !== 'connected'"
      :title="stateText"
      :type="connection.state === 'error' ? 'error' : 'warning'"
      show-icon
      :closable="false"
      class="state-alert"
    >
      <el-button
        v-if="connection.state === 'idle' || connection.state === 'error'"
        size="small"
        type="primary"
        :loading="reconnecting"
        @click="reconnect"
      >
        重新连接
      </el-button>
    </el-alert>

    <div v-else class="session-inner">
      <el-radio-group v-model="tab" size="default" class="sub-tabs">
        <el-radio-button value="files">文件</el-radio-button>
        <el-radio-button value="transfers">传输</el-radio-button>
      </el-radio-group>

      <FilesView
        v-show="tab === 'files'"
        :connection-id="connection.id"
        :grants="grants"
      />
      <TransfersView v-show="tab === 'transfers'" :connection-id="connection.id" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ConnectionInfo, FileRootGrant } from '@shared/protocol'
import FilesView from './FilesView.vue'
import TransfersView from './TransfersView.vue'

const props = defineProps<{ connection: ConnectionInfo }>()
const tab = ref('files')
const reconnecting = ref(false)

const grants = computed<FileRootGrant[]>(() => props.connection.login?.grants ?? [])

async function reconnect(pw?: string): Promise<void> {
  reconnecting.value = true
  try {
    await window.api.client.reconnect(props.connection.id, pw)
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('未记住密码')) {
      try {
        const r = await ElMessageBox.prompt('该连接没有记住密码，输入一次即可重连（将自动记住）', '重新连接', {
          inputType: 'password',
          inputPlaceholder: '密码',
          inputValidator: (v: string) => !!v || '请输入密码'
        })
        await reconnect(r.value)
      } catch {
        /* 用户取消输入 */
      }
    } else {
      ElMessage.error(msg)
    }
  } finally {
    reconnecting.value = false
  }
}

const stateText = computed(() => {
  switch (props.connection.state) {
    case 'connecting':
      return '连接中…'
    case 'reconnecting':
      return '连接中断，正在重连…'
    case 'error':
      return props.connection.error ?? '连接异常'
    default:
      return '未连接'
  }
})
</script>

<style scoped>
.session-inner {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sub-tabs {
  align-self: flex-start;
}
.state-alert {
  max-width: 640px;
}
</style>
