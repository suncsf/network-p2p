import { getCurrentInstance, onUnmounted, ref, type Ref } from 'vue'

/**
 * 页面/弹窗唯一标识注册中心
 *
 * 标识格式：4 位十六进制，显示为 #aXXX（如 #a001）。
 * - 页面 ID：aXXX，全局顺序分配，登记于 FIXED_PAGE_IDS（新增页面 = 现有最大值 + 1，空缺不回补）。
 * - 弹窗 ID：aXXXbYYY = 宿主页 ID + 'b' + 3 位十六进制序号（如 a002b001）。
 * - dialogKey：'页面路由名::弹窗语义名'（语义名英文小写中划线，如 server::account-create）。
 *
 * 弹窗 ID 解析优先级：
 * 1. FIXED_DIALOG_IDS 精确表命中即用；
 * 2. PAGE_DIALOG_BASE 前缀表派生 aXXXbYYY，序号按 dialogKey 记忆并持久化到
 *    userData/config/page-id-store.json（经主进程 page-id.handler），跨会话稳定；
 * 3. 兜底：随机生成并固化到 page-id-store.json（同一 key 永久复用同一 ID）。
 *    随机页段取 a800~afff 高位区间，避开固定表顺延分配范围。
 *
 * AI 上下文：getPageRegistrySnapshot() 生成快照字符串，供未来 AI/chat 模块
 * 构建系统提示词时注入【当前全局上下文】。
 */
export type PageEntryType = 'page' | 'dialog'

export interface PageRegistryEntry {
  id: string
  title: string
  type: PageEntryType
  routeName?: string
  dialogKey?: string
}

/** 固定页面 ID 表：routeName → aXXX。未登记的页面每次启动随机换号，用户反馈的 #XXXX 将无法回溯，务必登记。 */
export const FIXED_PAGE_IDS: Record<string, string> = {
  workspace: 'a001',
  transfers: 'a004',
  server: 'a002',
  settings: 'a003'
}

/** 固定弹窗表：'页面::弹窗' → aXXXbYYY。需要与文档/反馈对照引用的关键弹窗在此硬编码。 */
export const FIXED_DIALOG_IDS: Record<string, string> = {
  'workspace::new-connection': 'a001b001',
  'server::account-create': 'a002b001',
  'server::grant-add': 'a002b002',
  'server::node-permission': 'a002b003'
}

/** 弹窗宿主前缀表：routeName → base（与 FIXED_PAGE_IDS 同值）。宿主在表内的弹窗自动获得稳定派生 ID。 */
export const PAGE_DIALOG_BASE: Record<string, string> = {
  workspace: 'a001',
  transfers: 'a004',
  server: 'a002',
  settings: 'a003'
}

const registry = new Map<string, PageRegistryEntry>()
/** dialogKey → 已固化 ID（含启动时从 page-id-store.json 加载的历史映射） */
const dialogIdStore = new Map<string, string>()
/** 随机兜底页段下限：远高于固定表顺延范围，避免与未来固定页冲突 */
const RANDOM_PAGE_MIN = 0x800
const RANDOM_PAGE_MAX = 0xfff

function hex3(n: number): string {
  return n.toString(16).padStart(3, '0')
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

function isDialogId(id: string): boolean {
  return /^a[0-9a-f]{3}b[0-9a-f]{3}$/.test(id)
}

function randomPageId(): string {
  let id: string
  do {
    id = `a${hex3(randomInt(RANDOM_PAGE_MIN, RANDOM_PAGE_MAX))}`
  } while (registry.has(id))
  return id
}

function randomDialogId(): string {
  let id: string
  do {
    id = `a${hex3(randomInt(RANDOM_PAGE_MIN, RANDOM_PAGE_MAX))}b${hex3(randomInt(0, 0xfff))}`
  } while (registry.has(id))
  return id
}

/** 同一 base 下已占用序号的最大值（固定表与固化映射一并计入，避免撞号） */
function maxSeqForBase(base: string): number {
  let max = 0
  const scan = (id: string): void => {
    if (id.startsWith(`${base}b`) && id.length === 8) {
      const seq = parseInt(id.slice(5), 16)
      if (Number.isFinite(seq) && seq > max) max = seq
    }
  }
  Object.values(FIXED_DIALOG_IDS).forEach(scan)
  dialogIdStore.forEach((id) => scan(id))
  return max
}

/** 解析弹窗 ID：固定表 → 前缀派生（按 key 固化）→ 随机兜底（按 key 固化） */
function resolveDialogId(dialogKey: string): string {
  const fixed = FIXED_DIALOG_IDS[dialogKey]
  if (fixed) return fixed

  const remembered = dialogIdStore.get(dialogKey)
  if (remembered && isDialogId(remembered)) return remembered

  let id: string
  const base = PAGE_DIALOG_BASE[dialogKey.split('::')[0] ?? '']
  if (base) {
    const next = maxSeqForBase(base) + 1
    id = next <= 0xfff ? `${base}b${hex3(next)}` : randomDialogId()
  } else {
    id = randomDialogId()
  }
  dialogIdStore.set(dialogKey, id)
  // 兜底映射固化到主进程；写入失败不影响本次会话
  void window.api.pageId.save(dialogKey, id)
  return id
}

/** 启动时加载主进程固化的 dialogKey → ID 映射（渲染端入口调用一次） */
export async function initPageIdStore(): Promise<void> {
  try {
    const dialogs = (await window.api.pageId.load()) as Record<string, string>
    Object.entries(dialogs ?? {}).forEach(([key, id]) => {
      if (typeof key === 'string' && isDialogId(id) && !dialogIdStore.has(key)) {
        dialogIdStore.set(key, id)
      }
    })
  } catch {
    /* 读取失败时新 key 走随机并重新固化 */
  }
}

function addEntry(entry: PageRegistryEntry): void {
  registry.set(entry.id, entry)
}

/**
 * 页面注册（仅供页面包装器使用；页面组件内禁止再包 PageWrapper，否则徽章叠印、注册表同页两条）。
 * 固定表命中用固定 ID；未登记 routeName 则随机（每次启动换号，务必登记 FIXED_PAGE_IDS）。
 * 组件实例销毁时自动注销（v-if 页面随切换、keep-alive 页面随 tab 关闭清理）。
 */
export function usePageId(title: string, opts: { type: 'page'; routeName: string }): Ref<string> {
  const routeName = opts.routeName
  const id = FIXED_PAGE_IDS[routeName] ?? randomPageId()
  addEntry({ id, title, type: 'page', routeName })
  const pageId = ref(id)
  if (getCurrentInstance()) {
    onUnmounted(() => {
      registry.delete(pageId.value)
    })
  }
  return pageId
}

/** 弹窗注册：打开时调用，返回稳定 ID（同步） */
export function registerDialog(title: string, dialogKey: string): string {
  const id = resolveDialogId(dialogKey)
  addEntry({ id, title, type: 'dialog', dialogKey })
  return id
}

/** 弹窗注销：所有关闭路径（取消/确定/右上角 X/ESC）都必须走到，否则注册表泄漏、AI 上下文残留 */
export function unregisterDialog(id: string): void {
  if (id) registry.delete(id)
}

/** 注入 AI 的全局上下文快照，形如：当前页面：#a001 工作区 (workspace)；打开的弹窗：#a002b001 新建账户 */
export function getPageRegistrySnapshot(): string {
  const pages: string[] = []
  const dialogs: string[] = []
  registry.forEach((e) => {
    const label = `#${e.id} ${e.title}${e.type === 'page' ? ` (${e.routeName})` : ''}`
    ;(e.type === 'page' ? pages : dialogs).push(label)
  })
  return `当前页面：${pages.length > 0 ? pages.join('、') : '无'}；打开的弹窗：${
    dialogs.length > 0 ? dialogs.join('、') : '无'
  }`
}

/** 人工反查：ID → 注册表条目（固定表未命中时配合 page-id-store.json 排查） */
export function findRegistryEntry(id: string): PageRegistryEntry | undefined {
  return registry.get(id)
}
