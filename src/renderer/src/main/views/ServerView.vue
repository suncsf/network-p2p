<template>
  <div class="server-view">
    <el-tabs v-model="tab">
      <!-- 服务控制 -->
      <el-tab-pane label="服务控制" name="control">
        <el-card shadow="never">
          <div class="status-row">
            <el-tag :type="status.running ? 'success' : 'info'" size="large">
              {{ status.running ? '运行中' : '已停止' }}
            </el-tag>
            <el-button v-if="!status.running" type="primary" @click="start">启动服务</el-button>
            <el-button v-else type="danger" @click="stop">停止服务</el-button>
          </div>
          <div class="ips">
            <span>本机局域网 IP：</span>
            <el-tag v-for="ip in status.interfaces" :key="ip" class="ip-tag">{{ ip }}</el-tag>
          </div>
          <el-alert
            class="hint"
            type="info"
            :closable="false"
            title="端口、传输接收策略（自动接收/需确认）等参数已统一移至「设置」页"
          />
          <el-button class="goto-settings" size="small" @click="emit('goSettings')">前往设置</el-button>
        </el-card>
      </el-tab-pane>

      <!-- 账户 -->
      <el-tab-pane label="账户" name="accounts">
        <div class="acc-toolbar">
          <el-button type="primary" @click="openCreate">新建账户</el-button>
          <el-button @click="loadAccounts">刷新</el-button>
        </div>
        <el-collapse v-model="expanded">
          <el-collapse-item v-for="a in accounts" :key="a.id" :name="a.id">
            <template #title>
              <div class="acc-title">
                <el-icon><User /></el-icon>
                <b>{{ a.username }}</b>
                <el-tag v-if="!a.enabled" type="info" size="small">已禁用</el-tag>
                <el-tag v-if="a.isAdmin" type="warning" size="small">管理员</el-tag>
                <span class="spacer"></span>
                <el-button size="small" @click.stop="toggleEnabled(a)">{{ a.enabled ? '禁用' : '启用' }}</el-button>
                <el-button size="small" @click.stop="resetPassword(a)">重置密码</el-button>
                <el-button size="small" type="danger" @click.stop="deleteAccount(a)">删除</el-button>
              </div>
            </template>

            <div class="grants">
              <div class="sub-title">可访问目录与权限</div>
              <el-table :data="a.grants" size="small">
                <el-table-column prop="label" label="名称" width="140" />
                <el-table-column prop="rootPath" label="目录" min-width="220" />
                <el-table-column label="根权限" min-width="200">
                  <template #default="{ row }">
                    <el-button size="small" @click="editGrant(a, row)">编辑权限树</el-button>
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="100">
                  <template #default="{ row }">
                    <el-button size="small" type="danger" text @click="removeGrant(row)">移除</el-button>
                  </template>
                </el-table-column>
              </el-table>
              <el-button class="add-grant" size="small" @click="openAddGrant(a)">+ 添加目录</el-button>
            </div>
          </el-collapse-item>
        </el-collapse>
      </el-tab-pane>

      <!-- 审计 -->
      <el-tab-pane label="审计日志" name="audit">
        <el-table :data="auditRows" size="small" height="calc(100vh - 200px)">
          <el-table-column prop="ts" label="时间" width="180">
            <template #default="{ row }">{{ new Date(row.ts).toLocaleString() }}</template>
          </el-table-column>
          <el-table-column prop="actor" label="用户" width="140" />
          <el-table-column prop="action" label="操作" width="140" />
          <el-table-column prop="detail" label="详情" />
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 新建账户 -->
    <el-dialog v-model="createVisible" width="420px">
      <template #header>
        <div class="dlg-header">
          <span>新建账户</span>
          <PageIdBadge :page-id="createPageId" />
        </div>
      </template>
      <el-form :model="createForm" label-width="80px">
        <el-form-item label="用户名">
          <el-input v-model="createForm.username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="createForm.password" show-password />
          <el-button class="pw-btn" @click="randPassword">随机生成</el-button>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" @click="createAccount">创建</el-button>
      </template>
    </el-dialog>

    <!-- 添加目录 -->
    <el-dialog v-model="grantVisible" width="520px">
      <template #header>
        <div class="dlg-header">
          <span>添加可访问目录</span>
          <PageIdBadge :page-id="grantPageId" />
        </div>
      </template>
      <el-form label-width="90px">
        <el-form-item label="目录路径">
          <el-input v-model="grantForm.rootPath" placeholder="/home/user/share" />
        </el-form-item>
        <el-form-item label="显示名称">
          <el-input v-model="grantForm.label" placeholder="共享目录" />
        </el-form-item>
        <el-form-item label="默认权限">
          <el-checkbox-group v-model="grantForm.perms">
            <el-checkbox v-for="p in permNames" :key="p" :value="p">{{ label(p) }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="grantVisible = false">取消</el-button>
        <el-button type="primary" @click="addGrant">添加</el-button>
      </template>
    </el-dialog>

    <!-- 编辑权限树 -->
    <el-dialog v-model="nodeVisible" width="560px">
      <template #header>
        <div class="dlg-header">
          <span>编辑权限树</span>
          <PageIdBadge :page-id="nodePageId" />
        </div>
      </template>
      <el-form label-width="90px">
        <el-form-item label="目录节点">
          <el-input v-model="nodeForm.path" placeholder="相对路径，根为 ." />
        </el-form-item>
        <el-form-item label="继承父级">
          <el-switch v-model="nodeForm.inherit" />
        </el-form-item>
        <el-form-item v-if="!nodeForm.inherit" label="权限">
          <el-checkbox-group v-model="nodeForm.perms">
            <el-checkbox v-for="p in permNames" :key="p" :value="p">{{ label(p) }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="nodeVisible = false">取消</el-button>
        <el-button type="primary" @click="saveNode">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { User } from '@element-plus/icons-vue'
import type { AccountView, GrantView, AuditRow } from '@shared/models'
import PageIdBadge from '@renderer/components/PageIdBadge.vue'
import { registerDialog, unregisterDialog } from '@renderer/composables/usePageRegistry'
import {
  PERMISSION_ALL,
  PERMISSION_LABELS,
  PERMISSION_ORDER,
  Permission,
  maskFromNames,
  maskToNames
} from '@shared/permissions'

const tab = ref('control')
const status = ref<{ running: boolean; interfaces: string[] }>({ running: false, interfaces: [] })
const permNames = PERMISSION_ORDER

const emit = defineEmits<{ goSettings: [] }>()

function label(p: string): string {
  return PERMISSION_LABELS[p] ?? p
}

async function loadStatus(): Promise<void> {
  const s = (await window.api.server.getStatus()) as {
    running: boolean
    interfaces: string[]
  }
  status.value = s
}

async function start(): Promise<void> {
  try {
    await window.api.server.start()
    ElMessage.success('服务端已启动')
    loadStatus()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function stop(): Promise<void> {
  await window.api.server.stop()
  ElMessage.info('服务端已停止')
  loadStatus()
}

/* ---------- 账户 ---------- */
const accounts = ref<AccountView[]>([])
const expanded = ref<number[]>([])

async function loadAccounts(): Promise<void> {
  accounts.value = (await window.api.accounts.list()) as AccountView[]
}

const createVisible = ref(false)
const createForm = reactive({ username: '', password: '' })
const createPageId = ref('')

watch(createVisible, (visible) => {
  if (visible) {
    createPageId.value = registerDialog('新建账户', 'server::account-create')
  } else if (createPageId.value) {
    unregisterDialog(createPageId.value)
    createPageId.value = ''
  }
})

function openCreate(): void {
  createForm.username = ''
  createForm.password = ''
  createVisible.value = true
}

async function randPassword(): Promise<void> {
  createForm.password = (await window.api.accounts.generatePassword(16)) as string
}

async function createAccount(): Promise<void> {
  if (!createForm.username || !createForm.password) {
    ElMessage.warning('请填写用户名与密码')
    return
  }
  await window.api.accounts.create({ ...createForm })
  ElMessage.success('账户已创建')
  createVisible.value = false
  loadAccounts()
}

async function toggleEnabled(a: AccountView): Promise<void> {
  await window.api.accounts.setEnabled({ id: a.id, enabled: !a.enabled })
  loadAccounts()
}

async function resetPassword(a: AccountView): Promise<void> {
  const pw = (await window.api.accounts.generatePassword(16)) as string
  await ElMessageBox.alert(`新密码：${pw}（请立即复制保存）`, '重置密码', { confirmButtonText: '我已保存' })
  await window.api.accounts.setPassword({ id: a.id, password: pw })
  loadAccounts()
}

async function deleteAccount(a: AccountView): Promise<void> {
  await ElMessageBox.confirm(`删除账户 ${a.username} 及其授权?`, '确认', { type: 'warning' })
  await window.api.accounts.delete(a.id)
  loadAccounts()
}

/* ---------- 目录授权 ---------- */
const grantVisible = ref(false)
const grantPageId = ref('')
const grantForm = reactive<{ accountId: number; rootPath: string; label: string; perms: string[] }>({
  accountId: 0,
  rootPath: '',
  label: '',
  perms: maskToNames(Permission.READ)
})

watch(grantVisible, (visible) => {
  if (visible) {
    grantPageId.value = registerDialog('添加可访问目录', 'server::grant-add')
  } else if (grantPageId.value) {
    unregisterDialog(grantPageId.value)
    grantPageId.value = ''
  }
})

function openAddGrant(a: AccountView): void {
  grantForm.accountId = a.id
  grantForm.rootPath = ''
  grantForm.label = ''
  grantForm.perms = maskToNames(Permission.READ)
  grantVisible.value = true
}

async function addGrant(): Promise<void> {
  await window.api.grants.add({
    accountId: grantForm.accountId,
    rootPath: grantForm.rootPath,
    label: grantForm.label || grantForm.rootPath,
    defaultMask: maskFromNames(grantForm.perms)
  })
  ElMessage.success('目录已添加')
  grantVisible.value = false
  loadAccounts()
}

async function removeGrant(row: GrantView): Promise<void> {
  await window.api.grants.remove(row.id)
  loadAccounts()
}

/* ---------- 权限树 ---------- */
const nodeVisible = ref(false)
const nodePageId = ref('')
const nodeForm = reactive<{ grantId: number; path: string; inherit: boolean; perms: string[] }>({
  grantId: 0,
  path: '.',
  inherit: false,
  perms: maskToNames(Permission.READ)
})

watch(nodeVisible, (visible) => {
  if (visible) {
    nodePageId.value = registerDialog('编辑权限树', 'server::node-permission')
  } else if (nodePageId.value) {
    unregisterDialog(nodePageId.value)
    nodePageId.value = ''
  }
})

function editGrant(_a: AccountView, row: GrantView): void {
  nodeForm.grantId = row.id
  nodeForm.path = '.'
  nodeForm.inherit = false
  nodeForm.perms = maskToNames(row.defaultMask)
  nodeVisible.value = true
}

async function saveNode(): Promise<void> {
  await window.api.grants.setNode({
    grantId: nodeForm.grantId,
    path: nodeForm.path,
    inherit: nodeForm.inherit,
    mask: nodeForm.inherit ? 0 : maskFromNames(nodeForm.perms)
  })
  ElMessage.success('权限已保存')
  nodeVisible.value = false
  loadAccounts()
}

/* ---------- 审计 ---------- */
const auditRows = ref<AuditRow[]>([])

async function loadAudit(): Promise<void> {
  auditRows.value = (await window.api.audit.list(200)) as typeof auditRows.value
}

onMounted(() => {
  loadStatus()
  loadAccounts()
  loadAudit()
})
void PERMISSION_ALL
</script>

<style scoped>
.status-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}
.hint {
  margin-top: 16px;
}
.goto-settings {
  margin-top: 12px;
}
.ips {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ip-tag {
  margin-right: 4px;
}
.acc-toolbar {
  margin-bottom: 12px;
  display: flex;
  gap: 8px;
}
.acc-title {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.spacer {
  flex: 1;
}
.sub-title {
  font-weight: 600;
  margin-bottom: 8px;
}
.add-grant {
  margin-top: 8px;
}
.pw-btn {
  margin-left: 8px;
}
.dlg-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
