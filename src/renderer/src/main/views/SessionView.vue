<template>
  <div class="session">
    <el-alert
      v-if="connection.state !== 'connected'"
      :title="stateText"
      :type="connection.state === 'error' ? 'error' : 'warning'"
      show-icon
      :closable="false"
      class="state-alert"
    />

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
import type { ConnectionInfo, FileRootGrant } from '@shared/protocol'
import FilesView from './FilesView.vue'
import TransfersView from './TransfersView.vue'

const props = defineProps<{ connection: ConnectionInfo }>()
const tab = ref('files')

const grants = computed<FileRootGrant[]>(() => props.connection.login?.grants ?? [])

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
