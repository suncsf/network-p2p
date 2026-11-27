# 2026-11-26 当日核心索引

> 关键词 → 记忆文件 映射；只放索引和摘要，详细内容见记忆文件。

| 关键词 | 记忆文件 | 摘要 |
| --- | --- | --- |
| 悬浮窗 | [悬浮窗文件工具开发.md](悬浮窗文件工具开发.md) | 圆形悬浮球：置顶/可拖动/状态点/进度环/待接收闪烁，点击展开主窗口 |
| 多连接选项卡 | [悬浮窗文件工具开发.md](悬浮窗文件工具开发.md) | ConnectionManager 多客户端实例；工作区卡片选项卡 + SessionView 文件/传输子页 |
| P2P传输 | [悬浮窗文件工具开发.md](悬浮窗文件工具开发.md) | 局域网 UDP 定位 + TCP 直连，64KB 分块/SHA-256/一次性 token/接收确认默认开启 |
| 树形权限 | [悬浮窗文件工具开发.md](悬浮窗文件工具开发.md) | 7 权限位、子目录继承父级可覆盖、最近显式覆盖生效、服务端二次校验 |
| WebSocket服务端 | [悬浮窗文件工具开发.md](悬浮窗文件工具开发.md) | 自建服务端：scrypt 鉴权/锁定/审计/端口预检，自研 JSON-RPC 协议 |
| SQLite存储 | [悬浮窗文件工具开发.md](悬浮窗文件工具开发.md) | better-sqlite3 双库（服务端 lattice.db + 本地 local.db），独立迁移版本表 |
| Electron打包 | [悬浮窗文件工具开发.md](悬浮窗文件工具开发.md) | deb 106MB + AppImage 132MB 已产出；Windows NSIS 走 Docker/CI 未完成 |
| 自发现 | [悬浮窗文件工具开发.md](悬浮窗文件工具开发.md) | 曾要求"默认关闭的局域网自发现"，随后取消，未实现 |
| 页面弹窗标识系统 | [页面弹窗标识系统.md](页面弹窗标识系统.md) | #aXXX 跨会话唯一标识落地：注册中心/徽章/包装器/持久化，弹窗 watch(visible) 收拢注册注销 |
| usePageRegistry | [页面弹窗标识系统.md](页面弹窗标识系统.md) | 三固定表（页面/弹窗/宿主前缀）+ 随机兜底 a800~afff，getPageRegistrySnapshot() 预留 AI 注入 |
| PageIdBadge | [页面弹窗标识系统.md](页面弹窗标识系统.md) | 徽章显示 #xxxx 点击复制；页面级左下角 left:228px，弹窗级在 #header 标题旁 |
| PageWrapper | [页面弹窗标识系统.md](页面弹窗标识系统.md) | 仅 App.vue 布局层使用；workspace v-show 常驻≈keep-alive，server/settings v-if |
| 固定ID表 | [页面弹窗标识系统.md](页面弹窗标识系统.md) | 页面 a001~a003；弹窗 a001b001 + a002b001~b003；未登记会随机换号无法反查 |
| page-id-store | [页面弹窗标识系统.md](页面弹窗标识系统.md) | dialogKey→ID 固化到 userData/config/page-id-store.json，IPC page-id:load/save |
| @renderer别名 | [页面弹窗标识系统.md](页面弹窗标识系统.md) | 脚手架缺陷：错指 src/renderer 应为 src/renderer/src，首用即 TS2307，已修 vite+tsconfig 两处 |
| 大文件传输 | [传输系统大文件与续传.md](传输系统大文件与续传.md) | 移除 8MB 上限：p2pPush 磁盘 64KB 分块直推 + 上传 4MB 分块，数据不经 WS 命令通道 |
| p2pPush | [传输系统大文件与续传.md](传输系统大文件与续传.md) | 服务端直推命令；授权字段必须叫 p2pToken（LatticeClient 会用登录 token 覆盖 params.token） |
| 统一传输面板 | [传输系统大文件与续传.md](传输系统大文件与续传.md) | 五状态标签面板：全部/进行中/已完成/已取消/已中断，取消/续传/删除/清除，transfer:updated 实时推送 |
| 断点续传 | [传输系统大文件与续传.md](传输系统大文件与续传.md) | P2P 协议 HELLO.resume + DECISION.offsets + 'r+' 续写；上传按 offset+uploadId；启动遗留 active→interrupted |
| TransferStore | [传输系统大文件与续传.md](传输系统大文件与续传.md) | local.db migration v2 建 transfers 表；TransferStore CRUD + onChange 广播；真库 1→2 迁移验证无损 |
| 自动接收修复 | [传输系统大文件与续传.md](传输系统大文件与续传.md) | 根因：updateConfig 不热更新 TransferManager 快照；新增 update() 即时生效 + 回归测试 |
| 服务配置合并 | [传输系统大文件与续传.md](传输系统大文件与续传.md) | ServerView 只留启停/状态/IP + 前往设置；SettingsView 唯一参数入口（含自动选空闲端口） |
| 文件列表右键菜单 | [文件列表视图右键菜单.md](文件列表视图右键菜单.md) | ContextMenu.vue 浮层组件；行菜单（打开/下载/P2P传/重命名/删除/复制路径）+ 空白菜单（上传/新建/刷新），按权限禁用 |

## 当日要点

- 项目从零到可运行：32 项测试全过、双端类型检查 0 错误、Linux 双格式安装包产出。
- 交互重构：单连接 → 多连接多选项卡。
- Windows 打包暂停（用户决定先调试运行），wine 镜像已拉取。
- 页面/弹窗唯一标识体系（#aXXX）按通用规范落地，typecheck 0 错误 / build 通过 / 32 测试通过；修复 @renderer 别名脚手架缺陷。
- 大文件传输去上限：p2pPush 磁盘直推 + 上传 4MB 分块；修复登录 token 覆盖 P2P 授权 token 的关键 bug（p2pToken 改名）与 updateConfig 热更新失效（自动接收 bug）。
- 统一传输面板上线：local.db transfers 表 + TransferStore/TransferRunner + P2P 断点续传协议（HELLO.resume/DECISION.offsets）；41 测试全绿。
- 服务端页与设置页配置合并为设置页单入口；文件列表页新增列表/卡片视图切换与右键菜单。
