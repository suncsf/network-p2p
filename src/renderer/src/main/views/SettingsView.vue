<template>
  <div class="settings">
    <el-card shadow="never" header="服务端参数">
      <el-form label-width="160px">
        <el-form-item label="WS 监听端口">
          <el-input-number v-model="config.wsPort" :min="1" :max="65535" />
        </el-form-item>
        <el-form-item label="P2P TCP 端口">
          <el-input-number v-model="config.p2pPort" :min="1" :max="65535" />
        </el-form-item>
        <el-form-item label="传输确认超时(ms)">
          <el-input-number v-model="config.confirmTimeoutMs" :min="5000" :step="5000" />
        </el-form-item>
        <el-form-item label="接收策略">
          <el-radio-group v-model="receiveMode">
            <el-radio value="confirm">需要确认（默认）</el-radio>
            <el-radio value="auto">自动接收</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="失败锁定次数">
          <el-input-number v-model="config.lockAfter" :min="1" :max="20" />
        </el-form-item>
        <el-form-item label="锁定时长(分钟)">
          <el-input-number v-model="lockMinutes" :min="1" :max="1440" />
        </el-form-item>
        <el-form-item label=" ">
          <el-button type="primary" @click="save">保存</el-button>
          <el-button @click="freePort">自动选空闲端口</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" header="说明" class="note">
      <ul>
        <li>端口修改后需重启服务端生效；端口被占用时可一键自动选择空闲端口。</li>
        <li>接收策略保存后立即对运行中的服务端生效（端口除外）。</li>
        <li>服务端的启动/停止请在「服务端」页操作。</li>
        <li>关闭窗口不会退出程序，程序会隐藏在右下角托盘图标中。</li>
        <li>悬浮球可拖动到任意位置，点击展开主界面。</li>
      </ul>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue'
import { ElMessage } from 'element-plus'

const config = reactive({
  wsPort: 47100,
  p2pPort: 47101,
  confirmTimeoutMs: 60000,
  autoAccept: false,
  lockAfter: 5,
  lockMs: 300000
})

const lockMinutes = computed({
  get: () => Math.round(config.lockMs / 60000),
  set: (v: number) => (config.lockMs = v * 60000)
})

const receiveMode = computed({
  get: () => (config.autoAccept ? 'auto' : 'confirm'),
  set: (v: string) => (config.autoAccept = v === 'auto')
})

async function load(): Promise<void> {
  const c = (await window.api.server.getConfig()) as typeof config
  Object.assign(config, c)
}

async function save(): Promise<void> {
  await window.api.server.setConfig({ ...config })
  ElMessage.success('已保存')
}

async function freePort(): Promise<void> {
  Object.assign(config, await window.api.server.freePort())
  ElMessage.success('已切换为空闲端口')
}

onMounted(load)
</script>

<style scoped>
.settings {
  max-width: 720px;
}
.note {
  margin-top: 16px;
}
.note ul {
  margin: 0;
  padding-left: 18px;
  color: #606266;
  line-height: 1.9;
}
</style>
