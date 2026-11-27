import { app, BrowserWindow, dialog, ipcMain, Tray, Menu, Notification, nativeImage, safeStorage, screen } from 'electron'
import { join, dirname, basename } from 'path'
import { existsSync } from 'fs'
import { openDatabase, type Db } from './server/db'
import { LocalStore } from './store'
import { TransferStore } from './transfers'
import { TransferRunner, type StartUploadBatchParams, type StartUploadParams } from './transfer-runner'
import { LatticeServer, type ServerConfig } from './server/service'
import { LatticeClient, type ConnectionState } from './client/client'
import { ConnectionManager } from './client/manager'
import { generatePassword } from './server/auth'
import type { ServerEvent, TransferState } from '@shared/protocol'
import net from 'node:net'
import { getFreePort } from './util/ports'
import { attachDebug } from './util/debug'
import { registerPageIdIpc } from './ipc/page-id.handler'

const isDev = !app.isPackaged

// Linux 沙箱/无 GPU 环境下避免渲染进程崩溃
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-dev-shm-usage')
}

let userDb: Db
let local: LocalStore
let transfers: TransferStore
let runner: TransferRunner
let server: LatticeServer
let connections: ConnectionManager
let mainWindow: BrowserWindow | null = null
let floaterWindow: BrowserWindow | null = null
const FLOATER_SIZE = 72
let tray: Tray | null = null
let isQuitting = false

const DEFAULT_SERVER_CONFIG: ServerConfig = {
  wsPort: 47100,
  p2pPort: 47101,
  confirmTimeoutMs: 60000,
  autoAccept: false,
  lockAfter: 5,
  lockMs: 5 * 60 * 1000
}

function getIcon(): Electron.NativeImage {
  const p = join(__dirname, '../../resources/icons/icon.png')
  if (existsSync(p)) return nativeImage.createFromPath(p)
  // 兜底：生成一个 16x16 的占位图标
  return nativeImage.createEmpty()
}

function createFloater(): void {
  const state = local.getWindowState('floater') as { x?: number; y?: number } | undefined
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const size = FLOATER_SIZE
  floaterWindow = new BrowserWindow({
    width: size,
    height: size,
    x: state?.x ?? width - size - 24,
    y: state?.y ?? height - size - 24,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })
  floaterWindow.setAlwaysOnTop(true, 'floating')
  floaterWindow.setVisibleOnAllWorkspaces(true)
  attachDebug(floaterWindow, 'floater')
  floaterWindow.on('closed', () => {
    floaterWindow = null
  })
  floaterWindow.on('moved', () => {
    if (!floaterWindow) return
    const [x, y] = floaterWindow.getPosition()
    local.setWindowState('floater', { x, y })
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    floaterWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/floater.html`)
  } else {
    floaterWindow.loadFile(join(__dirname, '../renderer/floater.html'))
  }
}

function createMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return
  }
  mainWindow = null
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: true,
    title: 'v-Lattice',
    icon: getIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  attachDebug(mainWindow, 'main')

  // 关闭时隐藏到托盘（Windows/Ubuntu 通用）
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
  // 最小化同样隐藏到托盘（任务栏不保留）
  mainWindow.on('minimize', () => {
    mainWindow?.hide()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function safeSend(win: BrowserWindow | null, channel: string, payload?: unknown): void {
  // 窗口可能已销毁（退出中/渲染进程崩溃），此时调用 send 会抛 "Object has been destroyed"
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

/** 完全退出：托盘/悬浮球右键菜单共用。兜底 app.exit 防止挂起的 socket/handle 让进程残留 */
function quitApp(): void {
  isQuitting = true
  try {
    tray?.destroy()
  } catch {
    /* ignore */
  }
  app.quit()
  setTimeout(() => app.exit(0), 800).unref?.()
}

function sendToAll(channel: string, payload: unknown): void {
  safeSend(mainWindow, channel, payload)
  safeSend(floaterWindow, channel, payload)
}

function createTray(): void {
  tray = new Tray(getIcon())
  tray.setToolTip('v-Lattice')
  const menu = Menu.buildFromTemplate([
    { label: '显示主界面', click: () => createMainWindow() },
    {
      label: '启动服务端',
      click: async () => {
        try {
          await startServer()
        } catch (e) {
          new Notification({ title: '服务端启动失败', body: (e as Error).message }).show()
        }
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => createMainWindow())
}

async function startServer(): Promise<{ wsPort: number; p2pPort: number }> {
  if (server.isRunning()) return { wsPort: serverConfig.wsPort, p2pPort: serverConfig.p2pPort }
  await server.start()
  return { wsPort: serverConfig.wsPort, p2pPort: serverConfig.p2pPort }
}

/** 持久化当前打开的连接（重启后恢复工作区选项卡） */
function saveOpenConnections(): void {
  local.setSetting(
    'openConnections',
    connections.list().map((c) => ({ host: c.host, port: c.port, username: c.username }))
  )
}

/** 解密记住的连接密码（未记住/不可解密返回空串） */
function rememberedPassword(host: string, port: number, username: string): string {
  const enc = local.getConnectionPasswordByKey(host, port, username)
  if (!enc || !safeStorage.isEncryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

let serverConfig: ServerConfig = { ...DEFAULT_SERVER_CONFIG }

function registerIpc(): void {
  // 页面/弹窗标识持久化
  registerPageIdIpc()

  // 服务端
  ipcMain.handle('server:getConfig', () => serverConfig)
  ipcMain.handle('server:setConfig', (_e, patch: Partial<ServerConfig>) => {
    serverConfig = { ...serverConfig, ...patch }
    server.updateConfig(patch)
    local.setSetting('serverConfig', serverConfig)
    return serverConfig
  })
  ipcMain.handle('server:getStatus', () => ({
    running: server.isRunning(),
    config: serverConfig,
    interfaces: server.listInterfaces()
  }))
  ipcMain.handle('server:start', async () => {
    const ok = await LatticeServer.checkPort(serverConfig.wsPort)
    if (!ok) throw new Error(`端口 ${serverConfig.wsPort} 已被占用`)
    const ok2 = await LatticeServer.checkPort(serverConfig.p2pPort)
    if (!ok2) throw new Error(`端口 ${serverConfig.p2pPort} 已被占用`)
    return startServer()
  })
  ipcMain.handle('server:stop', async () => {
    await server.stop()
    return true
  })
  ipcMain.handle('server:freePort', async () => {
    serverConfig.wsPort = await getFreePort(serverConfig.wsPort)
    serverConfig.p2pPort = await getFreePort(serverConfig.p2pPort)
    server.updateConfig(serverConfig)
    local.setSetting('serverConfig', serverConfig)
    return serverConfig
  })

  // 账户
  ipcMain.handle('accounts:list', () => server.accountRepo.list())
  ipcMain.handle('accounts:create', (_e, p: { username: string; password: string; isAdmin?: boolean }) =>
    server.accountRepo.create(p.username, p.password, p.isAdmin)
  )
  ipcMain.handle('accounts:delete', (_e, id: number) => server.accountRepo.delete(id))
  ipcMain.handle('accounts:setPassword', (_e, p: { id: number; password: string }) =>
    server.accountRepo.setPassword(p.id, p.password)
  )
  ipcMain.handle('accounts:setEnabled', (_e, p: { id: number; enabled: boolean }) =>
    server.accountRepo.setEnabled(p.id, p.enabled)
  )
  ipcMain.handle('accounts:unlock', (_e, id: number) => server.accountRepo.unlock(id))
  ipcMain.handle('accounts:generatePassword', (_e, len?: number) => generatePassword(len ?? 16))
  ipcMain.handle('grants:add', (_e, p: { accountId: number; rootPath: string; label: string; defaultMask: number }) =>
    server.accountRepo.addGrant(p.accountId, p.rootPath, p.label, p.defaultMask)
  )
  ipcMain.handle('grants:remove', (_e, grantId: number) => server.accountRepo.removeGrant(grantId))
  ipcMain.handle('grants:setNode', (_e, p: { grantId: number; path: string; inherit: boolean; mask: number }) =>
    server.accountRepo.setNode(p.grantId, p.path, p.inherit, p.mask)
  )
  ipcMain.handle('audit:list', (_e, limit?: number) => server.auditRepo.list(limit ?? 200))

  // 客户端（多连接）
  ipcMain.handle(
    'client:connect',
    async (_e, opts: { host: string; port: number; username: string; password: string }) => {
      const info = await connections.connect(opts)
      // 默认全部存储：密码用 safeStorage 加密落库（Windows DPAPI / Linux libsecret）
      const passwordEnc =
        opts.password && safeStorage.isEncryptionAvailable()
          ? safeStorage.encryptString(opts.password).toString('base64')
          : null
      local.saveConnection(opts.host, opts.port, opts.username, passwordEnc)
      saveOpenConnections()
      sendToAll('state:connections', connections.list())
      return info
    }
  )
  // 重新打开历史连接（工作区「重新连接」按钮）：优先用记住的密码，未记住时由渲染层弹窗补输
  ipcMain.handle('client:reconnect', async (_e, p: { id: string; password?: string }) => {
    const info = connections.get(p.id)
    if (!info) throw new Error('连接不存在')
    const cur = connections.list().find((c) => c.id === p.id)
    if (cur?.state === 'connected') return info
    const pw = p.password || rememberedPassword(info.host, info.port, info.username)
    if (!pw) throw new Error('未记住密码')
    const r = await connections.connect({
      host: info.host,
      port: info.port,
      username: info.username,
      password: pw,
      id: p.id
    })
    // 重连时输入的密码同样默认记住，下次免输入
    if (p.password && safeStorage.isEncryptionAvailable()) {
      local.saveConnection(
        info.host,
        info.port,
        info.username,
        safeStorage.encryptString(p.password).toString('base64')
      )
    }
    saveOpenConnections()
    sendToAll('state:connections', connections.list())
    return r
  })
  ipcMain.handle('client:list', () => connections.list())
  ipcMain.handle('client:disconnect', async (_e, id: string) => {
    const ok = await connections.disconnect(id)
    saveOpenConnections()
    sendToAll('state:connections', connections.list())
    return ok
  })
  ipcMain.handle('client:state', (_e, id?: string) => {
    if (!id) return connections.list()
    return connections.get(id) ?? null
  })
  ipcMain.handle('client:request', (_e, p: { id: string; method: string; params: Record<string, unknown> }) =>
    connections.request(p.id, p.method, p.params)
  )
  ipcMain.handle('client:pendingTransfers', () => server.transferManager.listPending())
  ipcMain.handle('client:decideTransfer', (_e, p: { sessionId: string; accept: boolean }) =>
    server.transferManager.decide(p.sessionId, p.accept)
  )
  // P2P 接收准备：确保本机服务端在运行（P2P 接收端依赖它），选择保存位置并创建一次性接收授权，
  // 同时落一条 p2p-recv 传输记录（面板可见，含续传上下文）
  ipcMain.handle(
    'p2p:prepareReceive',
    async (
      _e,
      p: { connId: string; root: string; path: string; name: string; size?: number; isDir: boolean }
    ) => {
      if (!server.isRunning()) {
        const ok1 = await LatticeServer.checkPort(serverConfig.wsPort)
        const ok2 = await LatticeServer.checkPort(serverConfig.p2pPort)
        if (!ok1 || !ok2) throw new Error('本机服务端端口被占用，无法启动 P2P 接收端')
        await startServer()
      }
      let localDir: string
      let rename: string | undefined
      if (p.isDir) {
        const r = await dialog.showOpenDialog({ title: '选择接收目录', properties: ['openDirectory', 'createDirectory'] })
        if (r.canceled || r.filePaths.length === 0) throw new Error('CANCELLED')
        localDir = r.filePaths[0]
      } else {
        const r = await dialog.showSaveDialog({ title: '保存到', defaultPath: p.name })
        if (r.canceled || !r.filePath) throw new Error('CANCELLED')
        localDir = dirname(r.filePath)
        rename = basename(r.filePath)
      }
      const grant = server.createLocalTransferGrant(localDir)
      const peer = connections.get(p.connId)?.username ?? '远端'
      transfers.create({
        kind: 'p2p-recv',
        peer,
        name: rename ?? p.name,
        remotePath: p.path,
        localPath: rename ? join(localDir, rename) : localDir,
        total: p.size ?? 0,
        state: 'active',
        sessionId: grant.sessionId,
        resume: JSON.stringify({
          connId: p.connId,
          host: connections.get(p.connId)?.host,
          port: connections.get(p.connId)?.port,
          username: connections.get(p.connId)?.username,
          root: p.root,
          path: p.path,
          dir: localDir,
          rename,
          isDir: p.isDir,
          name: p.name
        })
      })
      return { ...grant, rename }
    }
  )

  // 统一传输面板
  ipcMain.handle('transfer:list', (_e, state?: TransferState) => transfers.list(state))
  ipcMain.handle('transfer:cancel', (_e, id: number) => runner.cancel(id))
  ipcMain.handle('transfer:resume', (_e, id: number) => runner.resume(id))
  ipcMain.handle('transfer:remove', (_e, id: number) => {
    transfers.remove(id)
    return true
  })
  ipcMain.handle('transfer:clearFinished', () => {
    transfers.clearFinished()
    return true
  })
  // p2pPush 命令本身失败（如无权限）时由渲染层调用：把相关记录标记为已取消
  ipcMain.handle('transfer:fail', (_e, p: { sessionId: string; message: string }) => {
    for (const r of transfers.getBySession(p.sessionId)) {
      if (r.state === 'active') transfers.update(r.id, { state: 'cancelled', error: p.message })
    }
    return true
  })
  ipcMain.handle('transfer:startUpload', (_e, p: StartUploadParams) => runner.startUpload(p))
  // 批量上传：多选文件/文件夹（主进程展开目录并保留结构，逐个排队上传）
  ipcMain.handle('transfer:startUploadBatch', (_e, p: StartUploadBatchParams) => runner.startUploadBatch(p))
  // 上传源选择：Windows 原生对话框无法同时选文件与目录，按 mode 分开（均可多选）
  ipcMain.handle('dialog:pickUpload', async (_e, mode: 'file' | 'dir') => {
    const r = await dialog.showOpenDialog({
      title: mode === 'dir' ? '选择要上传的文件夹（可多选）' : '选择要上传的文件（可多选）',
      properties: mode === 'dir' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })

  // 连接历史
  ipcMain.handle('history:list', () => local.listConnections())
  ipcMain.handle('history:remove', (_e, id: number) => local.removeConnection(id))
  // 取回历史连接记住的密码（safeStorage 解密；未记住/不可解密返回空串）
  ipcMain.handle('history:getPassword', (_e, id: number): string => {
    const enc = local.getConnectionPassword(id)
    if (!enc) return ''
    try {
      if (!safeStorage.isEncryptionAvailable()) return ''
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      return ''
    }
  })

  // 窗口
  ipcMain.handle('window:openMain', () => createMainWindow())
  ipcMain.handle('window:closeFloater', () => {
    if (floaterWindow && !floaterWindow.isDestroyed()) floaterWindow.hide()
  })
  ipcMain.handle('window:showFloater', () => {
    if (floaterWindow && !floaterWindow.isDestroyed()) floaterWindow.show()
  })
  // 悬浮球手动拖动：按增量移动，并约束在最近显示器工作区内（至少留 12px 可见）
  ipcMain.handle('window:floaterMoveBy', (_e, dx: number, dy: number) => {
    if (!floaterWindow || floaterWindow.isDestroyed()) return
    const [x, y] = floaterWindow.getPosition()
    const area = screen.getDisplayNearestPoint({ x, y }).workArea
    const nx = Math.min(Math.max(x + dx, area.x - FLOATER_SIZE + 12), area.x + area.width - 12)
    const ny = Math.min(Math.max(y + dy, area.y - FLOATER_SIZE + 12), area.y + area.height - 12)
    floaterWindow.setPosition(Math.round(nx), Math.round(ny))
  })
  ipcMain.handle('window:quit', () => quitApp())
  // 悬浮球右键菜单：原生 Menu，弹出锚定在悬浮球窗口
  ipcMain.handle('window:floaterMenu', () => {
    if (!floaterWindow || floaterWindow.isDestroyed()) return
    Menu.buildFromTemplate([
      { label: '打开界面', click: () => createMainWindow() },
      {
        label: '传输',
        click: () => {
          createMainWindow()
          // 主窗口可能刚创建（渲染层尚未挂载），先发一次，再延迟重发兜底
          sendToAll('nav:goto', 'transfers')
          setTimeout(() => sendToAll('nav:goto', 'transfers'), 800)
        }
      },
      { type: 'separator' },
      { label: '退出', click: () => quitApp() }
    ]).popup({ window: floaterWindow })
  })
}

function setupClient(): void {
  connections = new ConnectionManager(
    (info) => {
      sendToAll('state:connection', info)
      sendToAll('state:connections', connections.list())
    },
    (connId, ev: ServerEvent) => {
      sendToAll('server:event', { connId, ...ev })
      if (ev.event === 'transfer:incoming') {
        const d = ev.data as { from?: string; fileCount?: number }
        const n = new Notification({
          title: '收到传输请求',
          body: `来自 ${d.from ?? '未知'}，共 ${d.fileCount ?? 1} 个文件`
        })
        n.on('click', () => createMainWindow())
        n.show()
        safeSend(floaterWindow, 'floater:alert')
      } else if (ev.event === 'transfer:progress') {
        // 对端发送方取消/失败时，把本机对应的接收记录从「进行中」落到终态，避免永久卡住
        const d = ev.data as { sessionId?: string; cancelled?: boolean; failed?: boolean; reason?: string }
        if (d.sessionId && (d.cancelled || d.failed)) {
          for (const r of transfers.getBySession(d.sessionId)) {
            if (r.kind === 'p2p-recv' && r.state === 'active') {
              transfers.update(r.id, {
                state: d.cancelled ? 'cancelled' : 'interrupted',
                error: d.reason ?? (d.cancelled ? '对端已取消' : '对端传输失败')
              })
            }
          }
        }
      }
    }
  )
}

app.requestSingleInstanceLock()

if (!app.isPackaged) {
  // 开发/预览模式下使用独立的数据目录名，避免与 Electron 默认目录混淆
  app.setName('lattice')
}

app.on('second-instance', () => {
  createMainWindow()
})

app.whenReady().then(() => {
  // 去掉 Electron 默认的顶部应用菜单
  Menu.setApplicationMenu(null)

  const userData = app.getPath('userData')
  userDb = openDatabase(join(userData, 'lattice.db'))
  local = new LocalStore(openDatabase(join(userData, 'local.db')))
  const saved = local.getSetting<ServerConfig | null>('serverConfig', null)
  if (saved) serverConfig = { ...DEFAULT_SERVER_CONFIG, ...saved }

  // 传输记录存储：应用启动时把遗留的「进行中」标记为「已中断」（保留现场可续传）
  transfers = new TransferStore(local.database)
  transfers.interruptAll()
  transfers.onChange = (rec) => sendToAll('transfer:updated', rec)

  server = new LatticeServer(userDb, serverConfig, transfers)

  // 本机服务端事件（如远端发起的下载待确认、客户端连接）：本机渲染层不是自己服务端的
  // WS 客户端，需要在主进程转发给渲染层，并弹系统通知 + 悬浮球闪烁提醒
  server.onLocalEvent = (ev) => {
    if (ev.event === 'transfer:incoming') {
      sendToAll('server:event', ev)
      const d = ev.data as { from?: string; fileCount?: number }
      const n = new Notification({
        title: '收到下载请求',
        body: `来自 ${d.from ?? '未知'}，共 ${d.fileCount ?? 1} 个文件，请在「传输」面板确认`
      })
      n.on('click', () => createMainWindow())
      n.show()
      safeSend(floaterWindow, 'floater:alert')
    } else if (ev.event === 'client:login') {
      sendToAll('server:event', ev)
      const d = ev.data as { username?: string; address?: string }
      const n = new Notification({
        title: '客户端已连接',
        body: `${d.username ?? '未知用户'}（${d.address ?? '未知地址'}）已登录本机服务端`
      })
      n.on('click', () => createMainWindow())
      n.show()
      safeSend(floaterWindow, 'floater:alert')
    }
  }

  setupClient()

  runner = new TransferRunner(transfers, connections, server, (info) => {
    if (info.ok) {
      new Notification({ title: '传输完成', body: info.name }).show()
    } else {
      new Notification({ title: '传输已中断', body: `${info.name}：${info.message ?? '可在传输面板续传'}` }).show()
    }
    sendToAll('transfer:done', info)
  })

  registerIpc()
  createFloater()
  createMainWindow()
  createTray()

  // 恢复上次的工作区连接：记住密码的自动重连，否则以未连接选项卡呈现（可点「重新连接」）
  const savedConns = local.getSetting<Array<{ host: string; port: number; username: string }>>(
    'openConnections',
    []
  )
  for (const c of savedConns) {
    const info = connections.addInactive(c)
    const pw = rememberedPassword(c.host, c.port, c.username)
    if (pw) {
      void connections
        .connect({ host: c.host, port: c.port, username: c.username, password: pw, id: info.id })
        .catch(() => {})
    }
  }
  saveOpenConnections()
  sendToAll('state:connections', connections.list())

  // 若之前开启了服务端，自动启动
  if (local.getSetting<boolean>('serverAutoStart', false)) {
    startServer().catch(() => {})
  }

  app.on('activate', () => createMainWindow())
})

app.on('window-all-closed', () => {
  // 保持托盘常驻（Windows/Ubuntu 均如此）
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', async () => {
  try {
    await connections?.disconnectAll()
  } catch {
    /* ignore */
  }
  try {
    await server.stop()
  } catch {
    /* ignore */
  }
})
