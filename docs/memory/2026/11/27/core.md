# 2026-11-27 当日核心索引

> 关键词 → 记忆文件 映射；只放索引和摘要，详细内容见记忆文件。

| 关键词 | 记忆文件 | 摘要 |
| --- | --- | --- |
| 下载确认权 | [传输确认与进度.md](传输确认与进度.md) | 下载确认从发起方转移到文件所有方服务端：p2pPush 走待确认流程，拒绝/超时落「已取消」 |
| preAuthorized | [传输确认与进度.md](传输确认与进度.md) | 发起方本机主动下载的接收授权标记，requestConfirm 直接放行，不再"自己确认自己" |
| onLocalEvent | [传输确认与进度.md](传输确认与进度.md) | LatticeServer 本机事件钩子：本机渲染层不是自身服务端 WS 客户端，需主进程转发 |
| 客户端连接通知 | [传输确认与进度.md](传输确认与进度.md) | 登录成功发 client:login 事件，弹系统通知（用户名+来源 IP）+ 悬浮球闪烁 |
| 小文件下载 | [传输确认与进度.md](传输确认与进度.md) | 删除 ≤8MB readFile+浏览器下载分支，下载统一走 P2P，面板全有记录 |
| ACK进度 | [传输确认与进度.md](传输确认与进度.md) | 发送端进度改由 ACK 帧驱动（含续传基线），语义=接收端已落盘 |
| 传输速度 | [传输确认与进度.md](传输确认与进度.md) | 传输面板 EWMA 平滑速度 + 剩余时间；续传时接收端计入磁盘已有字节基线 |
| 记住密码 | [记住连接参数.md](记住连接参数.md) | 连接表单勾选记住，safeStorage 加密落库；表单自动填最近参数 |
| safeStorage | [记住连接参数.md](记住连接参数.md) | Win DPAPI / Linux libsecret 加密；local.db 迁移 v3 加 connections.password 列 |
| P2P协议v2 | [大文件续传修复.md](大文件续传修复.md) | CHUNK/ACK 偏移量 UInt32→BigUInt64（UInt32 上限 4G-1 越界即中断），P2P_VERSION=2 |
| 协议版本校验 | [大文件续传修复.md](大文件续传修复.md) | FrameParser 校验版本，新旧混连明确报错；两端必须同步更新 |
| 续传冲突CONFLICT | [大文件续传修复.md](大文件续传修复.md) | runner.resume 先置 active 再 preparePush 自撞；改为仅 pushJobs 存在才算冲突 |
| 无效token兜底 | [大文件续传修复.md](大文件续传修复.md) | 续传连接接收端授权过期时从记录上下文自动重建授权，任意一端可单方面续传 |
| 续传连接解析 | [大文件续传修复.md](大文件续传修复.md) | 原连接已断开→按 host/port/username 匹配现存连接，端点信息入续传上下文 |
| 历史连接恢复 | [历史连接管理.md](历史连接管理.md) | app_settings.openConnections 持久化，启动还原选项卡，记住密码的自动重连 |
| client:reconnect | [历史连接管理.md](历史连接管理.md) | 按 host/port/username 查记住的密码用原 id 直连；未记住时弹窗补输一次 |
| 密码默认存储 | [历史连接管理.md](记住连接参数.md) | 去掉勾选框，连接成功/重连补输一律加密落库（勾选框曾只在废弃 ConnectView 里） |
| 最近连接列表 | [历史连接管理.md](历史连接管理.md) | WorkspaceView 弹窗加回历史连接选择（ConnectView 弃用后 UI 曾完全丢失） |
| 选项卡关闭修复 | [历史连接管理.md](历史连接管理.md) | 无 socket 的恢复连接 disconnect 仅移除 info，选项卡可关闭 |
| 账户锁定 | [账户锁定解锁.md](账户锁定解锁.md) | 错误密码自动重连无限重试→反复锁死账户的恶性循环 |
| 自动重连禁止 | [账户锁定解锁.md](账户锁定解锁.md) | UNAUTHORIZED/LOCKED/FORBIDDEN 鉴权类失败停止重连（noRetry） |
| 账户解锁 | [账户锁定解锁.md](账户锁定解锁.md) | ServerView「已锁定」标签 + 解锁按钮（accounts:unlock），免等 5 分钟 |
| uploadInit确认 | [传输确认与进度.md](传输确认与进度.md) | WS 上传此前完全无确认直传落盘；现落盘前先确认，同路径 5 分钟免重复 |
| 确认先行 | [传输确认与进度.md](传输确认与进度.md) | receive 授权先确认后发 token（preAuthorized），确认不依赖对方挂连接 |
| 悬浮球拖动 | [悬浮球拖动.md](悬浮球拖动.md) | 悬浮球不可拖修复：app-region no-drag 铺满全窗所致，改手动 mousemove + floaterMoveBy IPC，4px 阈值区分点击 |
| floaterMoveBy | [悬浮球拖动.md](悬浮球拖动.md) | window:floaterMoveBy IPC 按增量移动悬浮球，约束最近显示器工作区（留 12px 可见） |
| 主进程watch | [调试环境.md](调试环境.md) | electron-vite dev 默认不监听主进程，dev 脚本加 --watch（根因级教训） |
| Electron二进制缺失 | [调试环境.md](调试环境.md) | Error: Electron uninstall → node install.js + ELECTRON_MIRROR 环境变量 |
| 测试EPERM | [调试环境.md](调试环境.md) | Windows 删 SQLite 临时目录被占用 → 测试清理前先 db.close() |
| git代理 | [调试环境.md](调试环境.md) | 7890 失效，实测 7897（Clash Verge）可用；直连 GitHub 不稳定 |
| 传输菜单独立 | [传输面板独立化.md](传输面板独立化.md) | 传输面板脱离连接 tab 成侧栏独立菜单：待确认请求来自本机服务端，与连接无关 |
| 待确认传输角标 | [传输面板独立化.md](传输面板独立化.md) | 侧栏「传输」角标：transfer:incoming 即刷 + 3s 轮询 listPending 兜底（decide/超时无事件） |
| 已传量显示 | [传输面板独立化.md](传输面板独立化.md) | 进行中记录恒显「已传 X / Y」，接收/推送/上传统一；volumeText() |
| 悬浮球右键菜单 | [悬浮球交互.md](悬浮球交互.md) | 原生 Menu.popup：打开界面/传输（nav:goto 导航+800ms 重发兜底）/退出 |
| 最小化隐藏托盘 | [悬浮球交互.md](悬浮球交互.md) | 主窗口 minimize 即 hide；Electron 45 该事件回调无参数、不可 preventDefault |
| 完全退出 | [悬浮球交互.md](悬浮球交互.md) | quitApp()：isQuitting + tray.destroy + app.quit + 800ms 兜底 app.exit(0)，托盘/悬浮球共用 |
| 页面保活 | [菜单切换保活.md](菜单切换保活.md) | 侧栏四页全 v-show 常驻不重挂载；pageActive 可见时轻量刷新数据不重置界面状态 |
| 最近连接删除 | [历史连接管理.md](历史连接管理.md) | 历史记录可删（二次确认+history.remove 连密码删）；点击仅填表单，去掉一键直连 |
| Electron菜单 | [移除应用菜单.md](移除应用菜单.md) | Menu.setApplicationMenu(null) 去掉顶部默认菜单；托盘/悬浮球自定义菜单不受影响，DevTools/刷新快捷键随菜单失效 |
| setApplicationMenu | [移除应用菜单.md](移除应用菜单.md) | app.whenReady 开头置 null 即可，Win/Linux 通用 |
| 软件更名 | [软件更名.md](软件更名.md) | Lattice → v-Lattice：窗口标题/托盘/品牌名/页面标题/包名/打包产物名/README 共 9 处文件 |
| v-Lattice | [软件更名.md](软件更名.md) | 新软件名；userData 目录、appId、内部类名有意保留旧名防数据丢失/升级断裂 |

## 当日要点

- 双机联调（Win11 服务端 100.3 ↔ Ubuntu 26 客户端 100.5）跑通新下载确认流程：发起方选保存位置 → 服务端弹通知确认 → 开始传输。
- 四个提交推送 GitHub：ec30420（确认权转移）、0e73b6f（登录通知）、47de6cb（记住参数+速度+进度一致），并从远端拉回 c14ba88（窗口防护）。
- typecheck 0 错误、41 项测试全绿。

### 第二轮（同日）

- 协议升 v2 修 >4GB 中断（BigUInt64 + 版本校验），修续传三连败（CONFLICT 自撞 / 无效 token 授权过期兜底 / 原连接已断开按端点匹配），提交 7e8756b、7919c5d、4cc79bb。
- 历史连接：openConnections 持久化恢复 + client:reconnect 一键重连 + 密码默认全部存储 + 最近连接列表回归 + 选项卡关闭修复（7e8756b、4e70754）。
- 账户锁定恶性循环根除（鉴权失败停止自动重连）+ 服务端解锁按钮（821a12c）。
- 接收确认补漏：WS 上传 uploadInit 确认、receive 授权确认先行（确认不依赖对方挂连接），测试增至 45 项全绿。

### 第三轮（同日）

- 传输面板独立成侧栏「传输」菜单（脱离连接 tab，固定页面 ID a004），进行中传输恒显「已传 X / Y」字节量，侧栏加待确认数角标（轮询兜底）。
- 悬浮球：修复点击即消失（openMain 不再 closeFloater）、主窗口最小化隐藏到托盘、右键原生菜单（打开界面/传输/退出）、quitApp 完全退出（tray.destroy + app.exit 兜底）。
- 侧栏四页 v-show 常驻保活（切换不刷新界面），pageActive 可见时轻量刷新数据。
- 最近连接可删除（二次确认）、点击仅填表单不再一键直连。
- 本轮均为渲染层 + 主进程小改，typecheck 0 错误；改动未提交 git。

### 第三轮（同日）

- 移除 Electron 自带菜单：`src/main/index.ts` 在 `app.whenReady()` 开头 `Menu.setApplicationMenu(null)`；托盘/悬浮球右键菜单不受影响，DevTools（Ctrl+Shift+I）/刷新（Ctrl+R）快捷键随默认菜单失效。
- 软件更名 v-Lattice：9 处文件同步（主窗口标题、托盘 tooltip、App.vue 品牌名、index/floater 页面标题、package.json + lock 包名 v-lattice、electron-builder.yml productName/copyright/maintainer、README 标题）；userData 目录（lattice）、appId（com.lattice.app）、内部类名有意保留旧名，防已有数据丢失与覆盖安装断裂。
