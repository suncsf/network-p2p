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
| git代理 | [调试环境.md](调试环境.md) | 7890 失效，实测 7897（Clash Verge）可用；直连多次实测可通（74f02ba/d5e4073/8dd908a），代理未启动时 -c 置空 URL 级代理直连是首选 |
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
| 接收传输记录 | [接收传输记录.md](接收传输记录.md) | 对方推送只弹确认不落记录；接收方向补建传输记录，传输面板可见 |
| ws-recv | [接收传输记录.md](接收传输记录.md) | 新传输类型：WS 上传推送的接收记录；uploadInit 建、chunk 回写进度、finish/abort/close 同步状态 |
| uploadRecs | [接收传输记录.md](接收传输记录.md) | uploadId→记录 id 映射；base64 长度换算落盘字节（含 padding 修正）回写进度 |
| p2p-recv补建 | [接收传输记录.md](接收传输记录.md) | 预授权分支 createRecvRecord；resume 上下文带接收目录供 validateToken 兜底重建授权 |
| 二次确认缓存 | [接收传输记录.md](接收传输记录.md) | ensureUploadAccepted 同路径 5 分钟滑动免确认（设计如此）；不同路径按代码仍会弹确认 |
| 批量上传 | [批量上传与多选下载.md](批量上传与多选下载.md) | 上传支持多选文件/文件夹：主进程 expandSources 递归展开保留结构，空目录先 mkdir 补建 |
| startUploadBatch | [批量上传与多选下载.md](批量上传与多选下载.md) | 批量上传入口：每文件一条 upload 记录（可单独取消/续传），enqueue/pump 顺序队列执行 |
| 顺序上传队列 | [批量上传与多选下载.md](批量上传与多选下载.md) | pump 逐个消费上传队列，避免大量并发；排队中取消的记录跳过 |
| pickUpload | [批量上传与多选下载.md](批量上传与多选下载.md) | dialog:pickUpload 原生多选对话框（file/dir 分开，Windows 无法混选）；上传按钮改 split-button 下拉 |
| 批量下载 | [批量上传与多选下载.md](批量上传与多选下载.md) | 列表勾选列 + 卡片复选框，下载选中项一次 P2P 会话，对方只确认一次 |
| 多路径推流 | [批量上传与多选下载.md](批量上传与多选下载.md) | p2pPush 新增 paths[]：collectTargets 多路径收集去重，单 manifest 推流，resumePush 支持续传 |
| 批量上传提交推送 | [批量上传与多选下载.md](批量上传与多选下载.md) | 提交 8dd908a（含两份记忆文档）推送 GitHub：绕过失效代理直连成功 |
| 非法路径 | [大文件续传修复.md](大文件续传修复.md) | 单选批量下载发送端续传抛 PathViolationError：paths 仅在 >1 项时落盘、path 又不存在 → collectForTransfer 收到 undefined |
| paths续传上下文 | [大文件续传修复.md](大文件续传修复.md) | preparePush 始终存完整 targets；prepareReceive 接收记录新增 paths；接收侧续传按原 paths 重放 |
| 批量续传丢文件 | [大文件续传修复.md](大文件续传修复.md) | 修复前多选批量续传只补第一项其余静默丢失；修复后完整重放 |
| 对端推送续传 | [大文件续传修复.md](大文件续传修复.md) | createRecvRecord 记录无对端 root/paths，本机不可续传，明确提示请在对端续传（替代误导的「权限不足」） |
| transfer-resume测试 | [大文件续传修复.md](大文件续传修复.md) | 新增双端真实 TransferRunner 续传回归测试 6 场景（transfer-resume.test.ts），47→53 全绿 |
| 传输连接分离 | [大文件续传修复.md](大文件续传修复.md) | 待办需求（未实施）：传输走独立连接，关工作区连接不断传输；仅完成代码勘察 |
| 服务端当前连接 | [服务端当前连接.md](服务端当前连接.md) | ServerView 新增「当前连接」页签：listSessions IPC 拉取 + server:event 事件驱动实时刷新 |
| listSessions | [服务端当前连接.md](服务端当前连接.md) | LatticeServer.listSessions()：sessions 遍历返回 username/address/loginAt/lastSeen |
| client:logout | [服务端当前连接.md](服务端当前连接.md) | socket close 时经 onLocalEvent 发断开事件；sessions.delete() 返回值防重（stop/disconnect/网络断开三路径收敛） |
| ServerSessionView | [服务端当前连接.md](服务端当前连接.md) | shared/models.ts 新增在线会话视图类型（username/address/loginAt/lastSeen） |
| 大文件误取消 | [大文件误取消修复.md](大文件误取消修复.md) | 50-60GB 传输无操作变「已取消」：全量 SHA-256 空转 + 授权 5 分钟过期 + p2pPush 30s 超时 + ACK 竞态四因叠加 |
| SHA-256跳过 | [大文件误取消修复.md](大文件误取消修复.md) | 发送前不再全量哈希（接收端从不校验），只 stat 取大小，manifest sha256 留空，50GB 秒开 |
| 授权有效期30分钟 | [大文件误取消修复.md](大文件误取消修复.md) | GRANT_TTL_MS 统一替换三处 5min 硬编码（发放×2 + 滑动续期），覆盖枚举+确认+连接握手耗时 |
| p2pPush超时放宽 | [大文件误取消修复.md](大文件误取消修复.md) | client.request 支持按请求 timeoutMs；ConnectionManager 对 p2pPush 自动放宽到 10 分钟 |
| onSent已写字节 | [大文件误取消修复.md](大文件误取消修复.md) | executePush 失败状态判定加入「已写入 socket 字节数」与记录已有 transferred，杜绝 ACK 竞态误标已取消丢断点 |
| 背压保护 | [大文件误取消修复.md](大文件误取消修复.md) | 发送端 socket.bufferSize > 16MB 等 drain 再发，防对端落盘慢内存积压；大分块 512KB 降逐块开销 8 倍 |
| 传输暂停 | [传输暂停与打开目录.md](传输暂停与打开目录.md) | 新增 paused 状态：上传挂起分块循环 / p2p-send 挂起推送任务 / p2p-recv 经 p2pPushPause 通知发送端挂起；ws-recv 不支持 |
| p2pPushPause | [传输暂停与打开目录.md](传输暂停与打开目录.md) | 新 WS 命令对（p2pPushPause/p2pPushResume）：接收端遥控发送端挂起/恢复推流，socket 保留原地继续 |
| 继续回退续传 | [传输暂停与打开目录.md](传输暂停与打开目录.md) | resume 优先原地唤醒，对端任务已不在自动回退完整续传；暂停前持久化断点防杀进程丢进度 |
| 打开目录 | [传输暂停与打开目录.md](传输暂停与打开目录.md) | transfer:reveal IPC：文件 showItemInFolder 选中 / 目录 openPath / 未落盘退回父目录；p2p-send 从续传上下文还原路径 |
| 收发叫法统一 | [收发叫法统一.md](收发叫法统一.md) | 传输方向文案统一为「下载（进本机）/上传（出本机）」：10 文件约 70 处，只改文案注释不动协议标识符 |
| 下载策略 | [收发叫法统一.md](收发叫法统一.md) | 设置页「接收策略」更名「下载策略」、「自动接收」→「自动下载」（ServerView tooltip 同步） |
| P2P上传 | [收发叫法统一.md](收发叫法统一.md) | 传输面板标签「P2P 发送」→「P2P 上传」（记录类型 p2p-send 不变） |
| P2P下载 | [收发叫法统一.md](收发叫法统一.md) | 传输面板标签「P2P 接收」→「P2P 下载」、「接收」→「下载」（p2p-recv/ws-recv 不变） |
| IP段检测 | [IP段检测.md](IP段检测.md) | 工作区连接新增 IP 段检测：识别本机网卡生成网段 → 并发探测默认端口 → 服务端返回确认数据才判「可连接」→ 双击回填表单 |
| net-probe | [IP段检测.md](IP段检测.md) | 新建探测模块：localNics 网卡识别/CIDR 推导、expandRange 网段展开（宽掩码收敛 /24）、probeHost HTTP 探测（校验 service=v-lattice）、probeRange 每批 32 并发 |
| 探测确认数据 | [IP段检测.md](IP段检测.md) | 服务端 HTTP server 对非 WS 升级请求返回 `{ service:'v-lattice', hostname, protocolVersion }`；只有收到确认数据才判可连接，端口开放但服务不匹配不误报 |
| workspace::ip-scan | [IP段检测.md](IP段检测.md) | 检测弹窗固定 ID a001b002；新建连接弹窗 IP 输入框 append 槽「检测」按钮，双击可连接行回填 host/port 并关窗 |

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

### 第四轮（同日）

- 修「别人推送的看不到传输记录」：接收方向（WS 上传推送 / P2P 对端推送）此前只弹确认不落记录，补建接收记录——新类型 `ws-recv`（WS 接收，uploadRecs 映射回写进度/取消/中断）、`p2p-recv` 预授权分支 createRecvRecord（resume 上下文带接收目录）。提交 d5e4073 推送 GitHub。
- 关键陷阱：transferGrant 接收授权全为 preAuthorized，requestConfirm 直接放行，记录补建必须放预授权分支。
- 二次确认疑问结论：ensureUploadAccepted 同路径 5 分钟滑动免确认系 4cc79bb 设计，不同路径仍会弹确认（无代码改动）。
- 回归测试 +2（e2e 挂 TransferStore），47 项全绿，typecheck 0 错误。

### 第四轮（同日）

- 上传多选：「上传」改 split-button 下拉（上传文件 / 上传文件夹，均可多选，Windows 无法混选故分入口）；主进程 expandSources 递归展开目录保留结构、空目录先 mkdir 补建，startUploadBatch 每文件一条记录经顺序队列逐个上传（可单独取消/续传）。
- 下载同理：列表加勾选列、卡片加复选框，「下载选中(N)」一次 P2P 会话批量推流；p2pPush 命令新增 paths[] 多路径支持（collectTargets 去重），对方只需确认一次，断点续传同步支持多路径。
- typecheck 0 错误、47 项测试全绿；改动未提交 git。

### 第五轮（同日）

- 提交并推送 `8dd908a`（批量上传与多选下载 + 两份记忆文档，12 文件 +463/-49）到 origin/main。
- git 代理实测补充：7890 未运行时 `-c http.https://github.com.proxy=` 置空绕过直连推送成功，直连已三次实测可通；排查靠 `git config --show-origin --list | grep proxy` 定位 URL 专用代理键。

### 第七轮（同日）

- 修断点续传「非法路径」（发送端面板续传）：根因是单选批量下载的发送端记录续传上下文 path/paths 双空（paths 仅 >1 项时落盘），`collectForTransfer(root, undefined)` 抛 PathViolationError；preparePush 改为始终存完整 targets、空路径明确报错。
- 顺带修两个相邻缺陷：多选批量续传只补第一项丢文件（接收记录现存完整 paths 按原样重放）；对端推送接收记录续传报误导性「权限不足」（改为明确提示请在对端续传）。
- 新增 transfer-resume.test.ts：双端真实 TransferRunner + 双 LatticeServer 的 6 场景续传回归（上传/单文件/多选/单选/对端推送/发送端续传）。typecheck 0 错误、53 项全绿；改动未提交 git。
- 待办：传输与工作区连接分离（传输走独立连接，关工作区连接不断传输）——需求已梳理未实施，仅完成勘察。

### 第六轮（同日）

- 服务端面板新增「当前连接」页签：`LatticeServer.listSessions()` + `server:listSessions` IPC + preload `api.server.listSessions`；ServerView 表格展示账户/来源地址/登录时间/最近活跃，空状态区分服务端未运行/暂无连接。
- 断开通知补齐：socket close 发 `client:logout`（经 onLocalEvent 转发，不弹通知），`sessions.delete()` 返回值防重，disconnect RPC 与 server.stop 三路径收敛。
- typecheck 0 错误、47 项测试全绿；改动未提交 git。

### 第八轮（同日）

- 修「传 50、60GB 文件/文件夹有时无操作被标已取消」，四根因：① sendFiles 连接前对全部文件全量 SHA-256（接收端从不校验）→ 50GB 空转数分钟；② 接收授权仅 5 分钟有效期，枚举+确认+哈希超时即「无效 token」→ 已取消；③ p2pPush RPC 固定 30s 超时，服务端枚举完整个文件夹才回复，大目录必超 → 渲染层 transfer:fail 标已取消；④ executePush 仅凭 ACK 判定取消/中断，断开瞬间 ACK 未达被误标已取消丢断点（S6 测试暴露）。
- 修复：跳过发送前哈希（只 stat，sha256 留空）；授权有效期 5→30 分钟（GRANT_TTL_MS 三处统一）；client.request 支持按请求超时、p2pPush 自动放宽 10 分钟；executePush 失败判定加入 onSent 已写字节与记录已有 transferred，只落 interrupted 保留断点。
- 顺带加固：DEFAULT_CHUNK_SIZE 64KB→512KB；发送端加背压保护（bufferSize>16MB 等 drain）。
- typecheck 0 错误、53 项测试全绿；改动未提交 git。遗留：发送方确认框 60s 超时自动取消（「已拒绝或确认超时」）系既有设计，未改。

### 第九轮（同日）

- 传输新增暂停：TransferState 新增 paused；上传挂起分块循环（服务端上传会话保留免重初始化）、p2p-send 挂起推送任务、p2p-recv 经新 WS 命令 p2pPushPause/p2pPushResume 遥控发送端挂起（socket 保留原地继续）；「继续」优先原地唤醒、失败回退完整续传；ws-recv（接收方向）不支持。暂停前持久化断点；cancel 放行 paused；executePush 注册前 abort 同会话旧任务防双 socket。
- 传输列表行新增「打开目录」：transfer:reveal IPC，文件 showItemInFolder 选中、目录 openPath、未落盘退回父目录；p2p-send 记录从续传上下文还原源路径。
- UI：进行中行「暂停」/ 已暂停行「继续」/「已暂停」页签 / 每行「打开目录」按钮（操作列宽 150→240）。
- 新增 S8/S9 暂停回归测试（48MB 大文件）；typecheck 0 错误、55 项测试全绿；改动未提交 git。

### 第九轮（同日）

- 收发叫法统一：传输方向文案统一为「下载（文件进本机）/ 上传（文件出本机）」，经确认范围为 UI 文案 + 注释 + 日志 + 通知/对话框标题 + 用户可见错误文案，协议字段与记录类型标识符（p2pPush、p2p-recv、ws-recv、direction:'send'/'receive'）一律不动，保证已存传输记录与断点续传数据兼容。
- 覆盖 10 文件约 70 处：TransfersView 类型标签（P2P 发送→P2P 上传、P2P 接收→P2P 下载、接收→下载）、设置页/服务端页「接收策略→下载策略」、下载对话框标题、4 条用户可见报错、protocol/service/fs-ops/transfer-runner/p2p-transfer 注释约 55 处。
- 有意保留：权限位 DOWNLOAD↔send 语义（仅补注释「对方从本机下载」）、4 个测试文件旧文案、编程语义的「事件推送/socket 分块发送」。
- typecheck 0 错误、55 项测试全绿；改动未提交 git。

### 第十轮（同日）

- 新增 IP 段检测服务功能（工作区「新建连接」弹窗）：IP 输入框 append 槽「检测」按钮 → 检测弹窗自动识别本机网卡生成网段（多网卡可选）→ 对网段内全部 IP 的默认端口并发探测 → 服务端对探测请求返回确认数据 `{ service:'v-lattice', hostname, protocolVersion }`，收到确认才判「可连接」→ 双击可连接行回填表单并关窗。
- 新建 `src/main/net-probe.ts`（localNics/expandRange/probeHost/probeRange，宽掩码收敛 /24、每批 32 并发、1.2s 超时、具体失败原因落表）；shared/protocol.ts 增 LocalNic/ProbeResult/ProbeRangeParams；service.ts http server 加确认响应；index.ts 注册 net:localNics/net:probe；preload 暴露 api.net；usePageRegistry 登记 workspace::ip-scan=a001b002。
- typecheck 0 错误；测试 54/55（S8 暂停用例为 700ms 时序抖动，单独重跑通过，与本功能无关）；改动未提交 git。
