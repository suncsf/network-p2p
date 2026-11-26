<template>
  <div class="files">
    <div class="toolbar">
      <el-select v-model="currentRoot" class="root-select" placeholder="选择目录" @change="onRoot">
        <el-option v-for="g in grants" :key="g.root" :label="`${g.label} (${g.root})`" :value="g.root" />
      </el-select>
      <el-breadcrumb separator="/" class="crumb">
        <el-breadcrumb-item>
          <a @click="goTo('')">根目录</a>
        </el-breadcrumb-item>
        <el-breadcrumb-item v-for="(seg, i) in segments" :key="i">
          <a @click="goTo(segments.slice(0, i + 1).join('/'))">{{ seg }}</a>
        </el-breadcrumb-item>
      </el-breadcrumb>
      <div class="actions">
        <el-radio-group v-model="viewMode" size="small" class="view-toggle">
          <el-radio-button value="list" title="列表视图">
            <span class="tg"><el-icon><Expand /></el-icon>列表</span>
          </el-radio-button>
          <el-radio-button value="card" title="卡片视图">
            <span class="tg"><el-icon><Grid /></el-icon>卡片</span>
          </el-radio-button>
        </el-radio-group>
        <el-button :icon="Refresh" circle @click="load" />
        <el-button :icon="Upload" :disabled="!perm('UPLOAD')" @click="pickUpload">上传</el-button>
        <el-button :icon="FolderAdd" :disabled="!perm('WRITE')" @click="promptMkdir">新建文件夹</el-button>
      </div>
    </div>

    <!-- 列表视图 -->
    <el-table
      v-if="viewMode === 'list'"
      v-loading="loading"
      :data="entries"
      height="calc(100vh - 170px)"
      @row-dblclick="onOpen"
      @row-contextmenu="onRowContextmenu"
      @contextmenu.prevent="openBlankMenu"
    >
      <el-table-column label="名称" min-width="280">
        <template #default="{ row }">
          <span class="name" @click="onOpen(row)">
            <el-icon v-if="row.type === 'dir'" color="#e6a23c"><Folder /></el-icon>
            <el-icon v-else color="#909399"><Document /></el-icon>
            <span class="txt">{{ row.name }}</span>
          </span>
        </template>
      </el-table-column>
      <el-table-column label="大小" width="120">
        <template #default="{ row }">{{ row.type === 'dir' ? '-' : formatSize(row.size) }}</template>
      </el-table-column>
      <el-table-column label="修改时间" width="180">
        <template #default="{ row }">{{ formatTime(row.mtime) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="320">
        <template #default="{ row }">
          <el-button
            v-if="row.type === 'file' && perm('READ')"
            link
            type="primary"
            @click="download(row)"
          >下载</el-button>
          <el-button
            v-if="perm('TRANSFER')"
            link
            type="success"
            @click="transfer(row)"
          >P2P 传</el-button>
          <el-button link type="warning" :disabled="!perm('RENAME')" @click="promptRename(row)">重命名</el-button>
          <el-button link type="danger" :disabled="!perm('DELETE')" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 卡片视图 -->
    <div
      v-else
      v-loading="loading"
      class="cards"
      @contextmenu.prevent="openBlankMenu"
    >
      <el-empty v-if="entries.length === 0 && !loading" description="空目录" :image-size="80" class="cards-empty" />
      <div
        v-for="row in entries"
        :key="row.path"
        class="card"
        @click="onOpen(row)"
        @contextmenu.prevent.stop="openMenu($event, row)"
      >
        <el-icon class="card-icon" :size="40" :color="row.type === 'dir' ? '#e6a23c' : '#909399'">
          <Folder v-if="row.type === 'dir'" />
          <Document v-else />
        </el-icon>
        <div class="card-name" :title="row.name">{{ row.name }}</div>
        <div class="card-meta">
          {{ row.type === 'dir' ? '文件夹' : formatSize(row.size) }} · {{ formatDay(row.mtime) }}
        </div>
      </div>
    </div>

    <ContextMenu
      :visible="menu.visible"
      :x="menu.x"
      :y="menu.y"
      :items="menu.items"
      @close="closeMenu"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Refresh,
  Upload,
  FolderAdd,
  Folder,
  Document,
  Expand,
  Grid,
  FolderOpened,
  Download,
  Share,
  EditPen,
  Delete,
  CopyDocument
} from '@element-plus/icons-vue'
import type { FileEntry, FileRootGrant } from '@shared/protocol'
import { resolvePermission, Permission } from '@shared/permissions'
import ContextMenu from '../../components/ContextMenu.vue'
import type { ContextMenuItem } from '../../components/context-menu'

const props = defineProps<{ connectionId: string; grants: FileRootGrant[] }>()

const currentRoot = ref(props.grants[0]?.root ?? '')
const currentPath = ref('')
const entries = ref<FileEntry[]>([])
const loading = ref(false)

/* ---------- 视图切换（列表 / 卡片，记忆偏好） ---------- */
type ViewMode = 'list' | 'card'
const VIEW_KEY = 'lattice.files.viewMode'
const viewMode = ref<ViewMode>(localStorage.getItem(VIEW_KEY) === 'card' ? 'card' : 'list')
watch(viewMode, (v) => localStorage.setItem(VIEW_KEY, v))

const segments = computed(() => currentPath.value.split('/').filter(Boolean))

const currentGrant = computed(() => props.grants.find((g) => g.root === currentRoot.value))

function perm(name: keyof typeof Permission): boolean {
  const g = currentGrant.value
  if (!g) return false
  const mask = resolvePermission(g.nodes, currentPath.value)
  return (mask & Permission[name]) !== 0
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString()
}

/* ---------- 右键菜单 ---------- */
const menu = ref<{ visible: boolean; x: number; y: number; items: ContextMenuItem[] }>({
  visible: false,
  x: 0,
  y: 0,
  items: []
})

function openMenu(e: MouseEvent, row: FileEntry): void {
  e.preventDefault()
  menu.value = { visible: true, x: e.clientX, y: e.clientY, items: rowItems(row) }
}

function openBlankMenu(e: MouseEvent): void {
  if (e.defaultPrevented) return // 行内右键已处理
  menu.value = { visible: true, x: e.clientX, y: e.clientY, items: blankItems() }
}

function closeMenu(): void {
  menu.value.visible = false
}

/** el-table 行右键（事件来自组件回调，需手动 preventDefault） */
function onRowContextmenu(row: FileEntry, _column: unknown, e: MouseEvent): void {
  e.preventDefault()
  menu.value = { visible: true, x: e.clientX, y: e.clientY, items: rowItems(row) }
}

function rowItems(row: FileEntry): ContextMenuItem[] {
  return [
    { label: '打开', icon: FolderOpened, disabled: row.type !== 'dir', action: () => onOpen(row) },
    {
      label: '下载',
      icon: Download,
      disabled: row.type !== 'file' || !perm('READ'),
      action: () => void download(row)
    },
    {
      label: 'P2P 传输',
      icon: Share,
      disabled: !perm('TRANSFER'),
      action: () => void transfer(row)
    },
    { divider: true },
    { label: '重命名', icon: EditPen, disabled: !perm('RENAME'), action: () => void promptRename(row) },
    { label: '删除', icon: Delete, danger: true, disabled: !perm('DELETE'), action: () => void remove(row) },
    { divider: true },
    { label: '复制路径', icon: CopyDocument, action: () => void copyPath(row) }
  ]
}

function blankItems(): ContextMenuItem[] {
  return [
    { label: '上传文件', icon: Upload, disabled: !perm('UPLOAD'), action: () => pickUpload() },
    { label: '新建文件夹', icon: FolderAdd, disabled: !perm('WRITE'), action: () => void promptMkdir() },
    { divider: true },
    { label: '刷新', icon: Refresh, action: () => void load() }
  ]
}

async function copyPath(row: FileEntry): Promise<void> {
  const full = row.path ? `${currentRoot.value}/${row.path}` : currentRoot.value
  try {
    await navigator.clipboard.writeText(full)
    ElMessage.success('路径已复制')
  } catch {
    ElMessage.error('复制失败')
  }
}

async function load(): Promise<void> {
  if (!currentGrant.value) return
  loading.value = true
  try {
    const r = (await window.api.client.request(props.connectionId, 'list', {
      root: currentRoot.value,
      path: currentPath.value
    })) as { entries: FileEntry[] }
    entries.value = r.entries
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

function onRoot(): void {
  currentPath.value = ''
  load()
}

function goTo(path: string): void {
  currentPath.value = path
  load()
}

function onOpen(row: FileEntry): void {
  if (row.type === 'dir') {
    currentPath.value = row.path
    load()
  }
}

async function promptMkdir(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('新建文件夹名称', '新建文件夹', { inputPattern: /^[^/\\]+$/ })
    await window.api.client.request(props.connectionId, 'mkdir', {
      root: currentRoot.value,
      path: joinPath(currentPath.value, value)
    })
    ElMessage.success('已创建')
    load()
  } catch {
    /* cancelled */
  }
}

async function promptRename(row: FileEntry): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('新名称', '重命名', { inputValue: row.name })
    await window.api.client.request(props.connectionId, 'rename', {
      root: currentRoot.value,
      path: row.path,
      newName: value
    })
    ElMessage.success('已重命名')
    load()
  } catch {
    /* cancelled */
  }
}

async function remove(row: FileEntry): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除 ${row.name} ?`, '删除确认', { type: 'warning' })
    await window.api.client.request(props.connectionId, 'delete', {
      root: currentRoot.value,
      path: row.path,
      recursive: row.type === 'dir'
    })
    ElMessage.success('已删除')
    load()
  } catch {
    /* cancelled */
  }
}

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name
}

async function download(row: FileEntry): Promise<void> {
  // 大文件走 P2P 直连（保存对话框选目标路径），避免命令通道整文件载入内存
  if (row.size > 8 * 1024 * 1024) {
    try {
      await p2pPush(row, false)
    } catch (e) {
      const msg = (e as Error).message
      if (msg !== 'CANCELLED') ElMessage.error(`P2P 下载失败：${msg}`)
    }
    return
  }
  try {
    const r = (await window.api.client.request(props.connectionId, 'readFile', {
      root: currentRoot.value,
      path: row.path
    })) as { data: string }
    // 通过浏览器下载
    const link = document.createElement('a')
    link.href = `data:application/octet-stream;base64,${r.data}`
    link.download = row.name
    link.click()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function pickUpload(): Promise<void> {
  const input = document.createElement('input')
  input.type = 'file'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      // Electron 45 移除了 file.path，用 webUtils 获取本地绝对路径
      const filePath = window.api.p2p.getPathForFile(file)
      if (!filePath) throw new Error('无法获取本地文件路径')
      // 上传由主进程执行（4MB 分块），支持取消与断点续传，进度见传输面板
      await window.api.transfers.startUpload({
        connId: props.connectionId,
        root: currentRoot.value,
        path: joinPath(currentPath.value, file.name),
        filePath,
        name: file.name,
        size: file.size
      })
      ElMessage.info('上传已开始，可在「传输」面板查看进度或取消')
    } catch (e) {
      ElMessage.error((e as Error).message)
    }
  }
  input.click()
}

interface P2pPrep {
  host: string
  port: number
  p2pToken: string
  sessionId: string
  rename?: string
}

/** 发起 P2P 直连传输：服务端直接从磁盘分块推流到本机接收端口，不经命令通道、无大小限制 */
async function p2pPush(row: FileEntry, isDir: boolean): Promise<void> {
  const prep = (await window.api.p2p.prepareReceive({
    connId: props.connectionId,
    root: currentRoot.value,
    path: row.path,
    name: row.name,
    size: row.size,
    isDir
  })) as P2pPrep
  ElMessage.info(`等待接收方确认…（目标 ${prep.host}:${prep.port}）`)
  try {
    const r = (await window.api.client.request(props.connectionId, 'p2pPush', {
      root: currentRoot.value,
      path: row.path,
      host: prep.host,
      port: prep.port,
      p2pToken: prep.p2pToken,
      sessionId: prep.sessionId,
      rename: prep.rename
    })) as { fileCount: number }
    ElMessage.info(`已发起 P2P 直连传输（${r.fileCount} 个文件），接收方确认后开始`)
  } catch (e) {
    // 推送发起失败：把接收记录标记为已取消，避免面板残留「进行中」
    await window.api.transfers.fail(prep.sessionId, (e as Error).message).catch(() => {})
    throw e
  }
}

async function transfer(row: FileEntry): Promise<void> {
  try {
    await p2pPush(row, true)
  } catch (e) {
    const msg = (e as Error).message
    if (msg !== 'CANCELLED') ElMessage.error(`P2P 传输失败：${msg}`)
  }
}

let unsubDone: (() => void) | undefined

onMounted(() => {
  load()
  // 主进程执行的上传完成后自动刷新列表
  unsubDone = window.api.on('transfer:done', (info) => {
    if ((info as { ok?: boolean }).ok) load()
  })
})

onUnmounted(() => {
  unsubDone?.()
})
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.root-select {
  width: 260px;
}
.crumb {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
}
.crumb a {
  cursor: pointer;
}
.actions {
  margin-left: auto;
}
.name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.txt {
  color: #303133;
}
.view-toggle {
  margin-right: 8px;
}
.tg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
  align-content: start;
  height: calc(100vh - 170px);
  overflow-y: auto;
  padding: 4px;
}
.cards-empty {
  grid-column: 1 / -1;
}
.card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 8px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
}
.card:hover {
  background: #f5f7fa;
  border-color: #ebeef5;
}
.card-icon {
  margin-bottom: 2px;
}
.card-name {
  max-width: 100%;
  font-size: 13px;
  color: #303133;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-meta {
  font-size: 11px;
  color: #909399;
}
</style>
