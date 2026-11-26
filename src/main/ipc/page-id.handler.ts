import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * 页面/弹窗标识持久化（规范见 docs/页面弹窗标识规范.md 与渲染端 usePageRegistry.ts）
 *
 * 存储：userData/config/page-id-store.json
 * 形态：{ version: 1, dialogs: { [dialogKey: string]: string } } —— dialogKey → ID 映射
 * 作用：未命中固定表的弹窗 dialogKey 跨会话固化，同一 key 永久复用同一 ID
 */
const STORE_REL = join('config', 'page-id-store.json')

interface PageIdStore {
  version: number
  dialogs: Record<string, string>
}

function storePath(): string {
  return join(app.getPath('userData'), STORE_REL)
}

function readStore(): PageIdStore {
  const p = storePath()
  if (!existsSync(p)) return { version: 1, dialogs: {} }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<PageIdStore>
    if (raw && typeof raw.dialogs === 'object' && raw.dialogs !== null) {
      return { version: 1, dialogs: raw.dialogs }
    }
  } catch {
    /* 文件损坏则重置，渲染端兜底走随机路径 */
  }
  return { version: 1, dialogs: {} }
}

function writeStore(store: PageIdStore): void {
  const p = storePath()
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(store, null, 2), 'utf-8')
}

export function registerPageIdIpc(): void {
  ipcMain.handle('page-id:load', () => readStore().dialogs)
  ipcMain.handle('page-id:save', (_e, p: { key: string; id: string }) => {
    if (!p || typeof p.key !== 'string' || typeof p.id !== 'string' || !p.key || !p.id) return false
    const store = readStore()
    if (store.dialogs[p.key] === p.id) return true
    store.dialogs[p.key] = p.id
    writeStore(store)
    return true
  })
}
