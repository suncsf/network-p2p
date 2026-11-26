import { app, BrowserWindow } from 'electron'

/** 调试辅助：在开发模式下通过 CDP 抓取渲染进程控制台与页面状态 */
export function attachDebug(window: BrowserWindow, name: string): void {
  if (app.isPackaged) return
  window.webContents.on('console-message', (_e, level, message) => {
    console.log(`[${name}][console:${level}]`, message)
  })
  window.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[${name}][load-fail] ${code} ${desc} ${url}`)
  })
  window.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[${name}][render-gone]`, details.reason)
  })
  window.webContents.once('did-finish-load', async () => {
    try {
      const title = await window.webContents.executeJavaScript('document.title')
      const hasApp = await window.webContents.executeJavaScript(
        'document.querySelector("#app") && document.querySelector("#app").children.length > 0'
      )
      const snippet = await window.webContents.executeJavaScript(
        'document.body.innerText.replace(/\\s+/g," ").slice(0,220)'
      )
      console.log(`[${name}][ready] title=${title} mounted=${hasApp} text="${snippet}"`)
    } catch (e) {
      console.error(`[${name}][probe-error]`, (e as Error).message)
    }
  })
}
