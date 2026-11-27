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
| 主进程watch | [调试环境.md](调试环境.md) | electron-vite dev 默认不监听主进程，dev 脚本加 --watch（根因级教训） |
| Electron二进制缺失 | [调试环境.md](调试环境.md) | Error: Electron uninstall → node install.js + ELECTRON_MIRROR 环境变量 |
| 测试EPERM | [调试环境.md](调试环境.md) | Windows 删 SQLite 临时目录被占用 → 测试清理前先 db.close() |
| git代理 | [调试环境.md](调试环境.md) | 7890 失效，实测 7897（Clash Verge）可用；直连 GitHub 不稳定 |

## 当日要点

- 双机联调（Win11 服务端 100.3 ↔ Ubuntu 26 客户端 100.5）跑通新下载确认流程：发起方选保存位置 → 服务端弹通知确认 → 开始传输。
- 四个提交推送 GitHub：ec30420（确认权转移）、0e73b6f（登录通知）、47de6cb（记住参数+速度+进度一致），并从远端拉回 c14ba88（窗口防护）。
- typecheck 0 错误、41 项测试全绿。
