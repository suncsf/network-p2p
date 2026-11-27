<template>
  <div class="connect">
    <el-card class="form-card" shadow="never">
      <template #header>
        <div class="card-header">
          <span>连接远程服务</span>
          <el-tag size="small" type="info">未连接时需要登录</el-tag>
        </div>
      </template>
      <el-form :model="form" label-width="90px" @submit.prevent="submit">
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
        <el-form-item label=" ">
          <el-checkbox v-model="form.rememberPassword">记住密码</el-checkbox>
        </el-form-item>
        <el-form-item v-if="error" label=" ">
          <el-alert :title="error" type="error" show-icon :closable="false" />
        </el-form-item>
        <el-form-item label=" ">
          <el-button type="primary" :loading="loading" @click="submit">连接</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card class="history-card" shadow="never" header="最近连接">
      <el-empty v-if="history.length === 0" description="暂无历史" :image-size="80" />
      <div v-for="h in history" :key="h.id" class="history-item">
        <div class="h-main" @click="fill(h)">
          <div class="h-host">{{ h.host }}:{{ h.port }}</div>
          <div class="h-user">{{ h.username }}</div>
        </div>
        <el-button text type="danger" size="small" @click="remove(h.id)">删除</el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { FileRootGrant, LoginResult } from '@shared/protocol'

const emit = defineEmits<{ connected: [grants: FileRootGrant[]] }>()

const form = reactive({ host: '127.0.0.1', port: 47100, username: '', password: '', rememberPassword: true })
const loading = ref(false)
const error = ref('')
const history = ref<Array<{ id: number; host: string; port: number; username: string; hasPassword: boolean }>>([])

async function fill(h: { id: number; host: string; port: number; username: string; hasPassword: boolean }): Promise<void> {
  form.host = h.host
  form.port = h.port
  form.username = h.username
  // 记住了密码就直接带出，免输
  form.password = h.hasPassword ? await window.api.history.getPassword(h.id) : ''
}

async function submit(): Promise<void> {
  error.value = ''
  if (!form.host || !form.username) {
    error.value = '请填写 IP 与账号'
    return
  }
  loading.value = true
  try {
    const result = (await window.api.client.connect({ ...form })) as LoginResult
    ElMessage.success('连接成功')
    emit('connected', result.grants)
    await loadHistory()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function loadHistory(): Promise<void> {
  history.value = (await window.api.history.list()) as typeof history.value
}

async function remove(id: number): Promise<void> {
  await window.api.history.remove(id)
  await loadHistory()
}

onMounted(async () => {
  await loadHistory()
  // 打开表单即自动填入最近一次连接的参数（含记住的密码）
  if (history.value.length > 0) await fill(history.value[0])
})
</script>

<style scoped>
.connect {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 16px;
  max-width: 900px;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}
.h-main {
  cursor: pointer;
}
.h-host {
  font-weight: 600;
}
.h-user {
  font-size: 12px;
  color: #909399;
}
</style>
