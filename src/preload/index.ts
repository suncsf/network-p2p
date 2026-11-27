import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

const api = {
  server: {
    getConfig: () => ipcRenderer.invoke('server:getConfig'),
    setConfig: (patch: unknown) => ipcRenderer.invoke('server:setConfig', patch),
    getStatus: () => ipcRenderer.invoke('server:getStatus'),
    start: () => ipcRenderer.invoke('server:start'),
    stop: () => ipcRenderer.invoke('server:stop'),
    freePort: () => ipcRenderer.invoke('server:freePort'),
    /** 服务端当前登录的连接列表 */
    listSessions: () => ipcRenderer.invoke('server:listSessions')
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    create: (p: unknown) => ipcRenderer.invoke('accounts:create', p),
    delete: (id: number) => ipcRenderer.invoke('accounts:delete', id),
    setPassword: (p: unknown) => ipcRenderer.invoke('accounts:setPassword', p),
    setEnabled: (p: unknown) => ipcRenderer.invoke('accounts:setEnabled', p),
    unlock: (id: number) => ipcRenderer.invoke('accounts:unlock', id),
    generatePassword: (len?: number) => ipcRenderer.invoke('accounts:generatePassword', len)
  },
  grants: {
    add: (p: unknown) => ipcRenderer.invoke('grants:add', p),
    remove: (grantId: number) => ipcRenderer.invoke('grants:remove', grantId),
    setNode: (p: unknown) => ipcRenderer.invoke('grants:setNode', p)
  },
  audit: {
    list: (limit?: number) => ipcRenderer.invoke('audit:list', limit)
  },
  net: {
    /** 本机 IPv4 网卡列表（含推导的网段 CIDR） */
    localNics: () => ipcRenderer.invoke('net:localNics'),
    /** 探测网段内所有 IP 的默认端口，返回每个 IP 的可连接状态 */
    probe: (p: { cidr: string; port: number }) => ipcRenderer.invoke('net:probe', p)
  },
  client: {
    connect: (opts: unknown) => ipcRenderer.invoke('client:connect', opts),
    reconnect: (id: string, password?: string) => ipcRenderer.invoke('client:reconnect', { id, password }),
    list: () => ipcRenderer.invoke('client:list'),
    disconnect: (id?: string) => ipcRenderer.invoke('client:disconnect', id),
    state: (id?: string) => ipcRenderer.invoke('client:state', id),
    request: (id: string, method: string, params: Record<string, unknown>) =>
      ipcRenderer.invoke('client:request', { id, method, params }),
    pendingTransfers: () => ipcRenderer.invoke('client:pendingTransfers'),
    decideTransfer: (p: unknown) => ipcRenderer.invoke('client:decideTransfer', p)
  },
  p2p: {
    prepareReceive: (p: unknown) => ipcRenderer.invoke('p2p:prepareReceive', p),
    /** Electron 45 已移除 file.path，用 webUtils 取本地绝对路径（上传用） */
    getPathForFile: (file: File) => webUtils.getPathForFile(file)
  },
  transfers: {
    list: (state?: string) => ipcRenderer.invoke('transfer:list', state),
    cancel: (id: number) => ipcRenderer.invoke('transfer:cancel', id),
    pause: (id: number) => ipcRenderer.invoke('transfer:pause', id),
    resume: (id: number) => ipcRenderer.invoke('transfer:resume', id),
    reveal: (id: number) => ipcRenderer.invoke('transfer:reveal', id),
    remove: (id: number) => ipcRenderer.invoke('transfer:remove', id),
    clearFinished: () => ipcRenderer.invoke('transfer:clearFinished'),
    fail: (sessionId: string, message: string) => ipcRenderer.invoke('transfer:fail', { sessionId, message }),
    startUpload: (p: unknown) => ipcRenderer.invoke('transfer:startUpload', p),
    /** 批量上传：多选文件/文件夹（主进程展开目录、逐个排队上传） */
    startUploadBatch: (p: unknown) => ipcRenderer.invoke('transfer:startUploadBatch', p)
  },
  dialog: {
    /** 选择上传源（mode: file 多选文件 / dir 多选文件夹），返回本机绝对路径列表 */
    pickUpload: (mode: 'file' | 'dir') => ipcRenderer.invoke('dialog:pickUpload', mode)
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    remove: (id: number) => ipcRenderer.invoke('history:remove', id),
    getPassword: (id: number) => ipcRenderer.invoke('history:getPassword', id)
  },
  window: {
    openMain: () => ipcRenderer.invoke('window:openMain'),
    closeFloater: () => ipcRenderer.invoke('window:closeFloater'),
    showFloater: () => ipcRenderer.invoke('window:showFloater'),
    moveFloaterBy: (dx: number, dy: number) => ipcRenderer.invoke('window:floaterMoveBy', dx, dy),
    floaterMenu: () => ipcRenderer.invoke('window:floaterMenu'),
    quit: () => ipcRenderer.invoke('window:quit')
  },
  pageId: {
    load: () => ipcRenderer.invoke('page-id:load'),
    save: (key: string, id: string) => ipcRenderer.invoke('page-id:save', { key, id })
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type LatticeApi = typeof api
