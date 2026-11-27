<template>
  <div class="transfers">
    <el-alert
      v-if="pending.length > 0"
      title="有待处理的传输请求"
      type="warning"
      show-icon
      :closable="false"
      class="banner"
    />
    <el-card shadow="never" header="待确认的传输">
      <el-empty v-if="pending.length === 0" description="暂无待确认请求" :image-size="90" />
      <div v-for="p in pending" :key="p.sessionId" class="req">
        <div class="info">
          <div class="from">来自 <b>{{ p.from }}</b></div>
          <div class="meta">
            {{ p.fileCount }} 个文件 · 共 {{ formatSize(p.totalSize) }} · {{ p.fileName }}
          </div>
          <el-progress
            :percentage="bar(p)"
            :format="() => `${Math.max(0, Math.ceil((p.expiresAt - now) / 1000))}s`"
            status="warning"
          />
        </div>
        <div class="ops">
          <el-button type="success" @click="decide(p.sessionId, true)">接受</el-button>
          <el-button type="danger" @click="decide(p.sessionId, false)">拒绝</el-button>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" class="panel">
      <template #header>
        <div class="panel-head">
          <span>传输记录</span>
          <div class="panel-ops">
            <el-button size="small" @click="refresh">刷新</el-button>
            <el-button size="small" type="danger" plain @click="clearFinished">清除已结束</el-button>
          </div>
        </div>
      </template>

      <el-tabs v-model="tab" class="state-tabs">
        <el-tab-pane name="all">
          <template #label>
            全部
            <el-badge v-if="records.length" :value="records.length" type="info" class="tab-badge" />
          </template>
        </el-tab-pane>
        <el-tab-pane name="active">
          <template #label>
            进行中
            <el-badge v-if="countOf('active')" :value="countOf('active')" class="tab-badge" />
          </template>
        </el-tab-pane>
        <el-tab-pane name="completed">
          <template #label>
            已完成
            <el-badge v-if="countOf('completed')" :value="countOf('completed')" type="success" class="tab-badge" />
          </template>
        </el-tab-pane>
        <el-tab-pane name="cancelled">
          <template #label>
            已取消
            <el-badge v-if="countOf('cancelled')" :value="countOf('cancelled')" type="info" class="tab-badge" />
          </template>
        </el-tab-pane>
        <el-tab-pane name="interrupted">
          <template #label>
            已中断
            <el-badge v-if="countOf('interrupted')" :value="countOf('interrupted')" type="warning" class="tab-badge" />
          </template>
        </el-tab-pane>
      </el-tabs>

      <el-table :data="filtered" empty-text="暂无传输记录" max-height="460">
        <el-table-column label="文件" min-width="200">
          <template #default="{ row }">
            <div class="f-name">{{ row.name }}</div>
            <div class="f-sub">{{ row.remotePath || row.localPath }}</div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="92">
          <template #default="{ row }">
            <el-tag :type="kindMeta(row.kind).type" size="small" effect="plain">{{ kindMeta(row.kind).label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对端" width="110">
          <template #default="{ row }">{{ row.peer || '-' }}</template>
        </el-table-column>
        <el-table-column label="进度" min-width="180">
          <template #default="{ row }">
            <template v-if="row.state === 'active'">
              <el-progress
                :percentage="pct(row)"
                :indeterminate="!row.total"
                :show-text="!!row.total"
                :stroke-width="8"
              />
              <div v-if="speeds.get(row.id)" class="speed-line">
                <span>{{ formatSize(speeds.get(row.id)!) }}/s</span>
                <span v-if="row.total">· 剩余 {{ etaOf(row) }}</span>
              </div>
            </template>
            <span v-else class="size-text">
              {{ row.total ? `${formatSize(row.transferred)} / ${formatSize(row.total)}` : formatSize(row.transferred) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="96">
          <template #default="{ row }">
            <el-tooltip v-if="row.error" :content="row.error" placement="top">
              <el-tag :type="stateMeta(row.state).type" size="small">{{ stateMeta(row.state).label }}</el-tag>
            </el-tooltip>
            <el-tag v-else :type="stateMeta(row.state).type" size="small">{{ stateMeta(row.state).label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="160">
          <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.state === 'active'" link type="danger" @click="cancel(row)">取消</el-button>
            <el-button v-if="resumable(row)" link type="primary" @click="resume(row)">续传</el-button>
            <el-button v-if="row.state !== 'active'" link type="danger" plain @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { TransferRecord, TransferRequestEvent, TransferState } from '@shared/protocol'

const props = defineProps<{ connectionId: string }>()
void props

const pending = ref<TransferRequestEvent[]>([])
const records = ref<TransferRecord[]>([])
const tab = ref<'all' | TransferState>('all')
const now = ref(Date.now())
let timer: number | undefined
let unsubEvent: (() => void) | undefined
let unsubUpdated: (() => void) | undefined

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

function bar(p: TransferRequestEvent): number {
  const remain = Math.max(0, p.expiresAt - now.value)
  return Math.min(100, (remain / 60000) * 100)
}

function pct(r: TransferRecord): number {
  if (!r.total) return 0
  return Math.min(100, Math.round((r.transferred / r.total) * 100))
}

/** 每条记录的实时速度（字节/秒，EWMA 平滑） */
const speeds = ref(new Map<number, number>())
/** 上次采样点（非响应式） */
const samples = new Map<number, { t: number; bytes: number }>()

/** 由进度更新事件推算速度：采样间隔 ≥200ms，指数平滑去抖 */
function trackSpeed(rec: TransferRecord): void {
  if (rec.state !== 'active') {
    speeds.value.delete(rec.id)
    samples.delete(rec.id)
    return
  }
  const now = Date.now()
  const last = samples.get(rec.id)
  if (!last || rec.transferred < last.bytes) {
    // 首次采样或进度回退（续传重置）：重建基线
    samples.set(rec.id, { t: now, bytes: rec.transferred })
    if (last) speeds.value.delete(rec.id)
    return
  }
  const dt = now - last.t
  if (dt < 200) return
  const instant = ((rec.transferred - last.bytes) / dt) * 1000
  samples.set(rec.id, { t: now, bytes: rec.transferred })
  const prev = speeds.value.get(rec.id)
  speeds.value.set(rec.id, prev ? prev * 0.6 + instant * 0.4 : instant)
}

function etaOf(r: TransferRecord): string {
  const v = speeds.value.get(r.id)
  if (!v || !r.total) return '--'
  const sec = Math.max(0, Math.round((r.total - r.transferred) / v))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`
}

const KIND_META: Record<string, { label: string; type: 'primary' | 'success' | 'warning' }> = {
  upload: { label: '上传', type: 'primary' },
  'p2p-send': { label: 'P2P 发送', type: 'warning' },
  'p2p-recv': { label: 'P2P 接收', type: 'success' }
}

function kindMeta(k: string): { label: string; type: 'primary' | 'success' | 'warning' } {
  return KIND_META[k] ?? { label: k, type: 'primary' }
}

const STATE_META: Record<TransferState, { label: string; type: 'primary' | 'success' | 'info' | 'warning' | 'danger' }> = {
  active: { label: '进行中', type: 'primary' },
  completed: { label: '已完成', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
  interrupted: { label: '已中断', type: 'warning' }
}

function stateMeta(s: TransferState): { label: string; type: 'primary' | 'success' | 'info' | 'warning' | 'danger' } {
  return STATE_META[s] ?? { label: s, type: 'info' }
}

/** 已中断可直接续传；P2P 取消的记录保留了部分文件，也允许续传（上传取消已清理半成品，不可续传） */
function resumable(r: TransferRecord): boolean {
  if (!['p2p-send', 'p2p-recv', 'upload'].includes(r.kind)) return false
  if (r.state === 'interrupted') return true
  return r.state === 'cancelled' && r.kind !== 'upload'
}

function countOf(s: TransferState): number {
  return records.value.filter((r) => r.state === s).length
}

const filtered = computed<TransferRecord[]>(() =>
  tab.value === 'all' ? records.value : records.value.filter((r) => r.state === tab.value)
)

function upsert(rec: TransferRecord): void {
  trackSpeed(rec)
  const i = records.value.findIndex((r) => r.id === rec.id)
  if (i >= 0) records.value.splice(i, 1, rec)
  else records.value.unshift(rec)
}

async function refresh(): Promise<void> {
  records.value = (await window.api.transfers.list()) as TransferRecord[]
  pending.value = (await window.api.client.pendingTransfers()) as TransferRequestEvent[]
}

async function decide(sessionId: string, accept: boolean): Promise<void> {
  await window.api.client.decideTransfer({ sessionId, accept })
  ElMessage.success(accept ? '已接受' : '已拒绝')
  refresh()
}

async function cancel(r: TransferRecord): Promise<void> {
  try {
    await window.api.transfers.cancel(r.id)
    ElMessage.info('已取消')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function resume(r: TransferRecord): Promise<void> {
  try {
    await window.api.transfers.resume(r.id)
    ElMessage.success(`已恢复传输：${r.name}`)
  } catch (e) {
    ElMessage.error(`续传失败：${(e as Error).message}`)
  }
}

async function remove(r: TransferRecord): Promise<void> {
  await window.api.transfers.remove(r.id)
  records.value = records.value.filter((x) => x.id !== r.id)
  speeds.value.delete(r.id)
  samples.delete(r.id)
}

async function clearFinished(): Promise<void> {
  await window.api.transfers.clearFinished()
  ElMessage.success('已清除已结束的记录')
  speeds.value.clear()
  samples.clear()
  refresh()
}

onMounted(() => {
  refresh()
  timer = window.setInterval(() => {
    now.value = Date.now()
  }, 500)
  unsubEvent = window.api.on('server:event', (ev) => {
    const e = ev as { event: string }
    if (e.event === 'transfer:incoming') refresh()
  })
  unsubUpdated = window.api.on('transfer:updated', (rec) => {
    upsert(rec as TransferRecord)
  })
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  unsubEvent?.()
  unsubUpdated?.()
})
</script>

<style scoped>
.banner {
  margin-bottom: 12px;
}
.panel {
  margin-top: 12px;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.panel-ops {
  display: flex;
  gap: 8px;
}
.state-tabs :deep(.el-tabs__header) {
  margin-bottom: 8px;
}
.tab-badge {
  margin-left: 6px;
  transform: translateY(-1px);
}
.req {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid #f0f0f0;
}
.info {
  flex: 1;
}
.from {
  font-size: 15px;
  margin-bottom: 4px;
}
.meta {
  font-size: 12px;
  color: #909399;
  margin-bottom: 8px;
}
.f-name {
  font-weight: 500;
  word-break: break-all;
}
.f-sub {
  font-size: 12px;
  color: #909399;
  word-break: break-all;
  margin-top: 2px;
}
.size-text {
  font-size: 12px;
  color: #606266;
}
.speed-line {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
  display: flex;
  gap: 6px;
}
</style>
