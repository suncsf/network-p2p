# Lattice — 设计方案与实施计划

> 一款基于 Electron + Element Plus + SQLite 的双模式文件工具：
> 既可作为**客户端**连接远程文件服务，也可**自建服务端**对外提供文件服务；
> 文件/目录传输采用**局域网 P2P 直连**。

> 状态：计划定稿（尚未开始编码）
> 目标平台：Windows 10+ / Ubuntu 24.04+

---

## 1. 需求概览

| 能力 | 说明 |
|---|---|
| 悬浮窗 | 圆形悬浮球始终置顶、可拖动；单击展开主窗口 |
| 客户端模式 | 未连接时提示输入 `IP / 端口 / 账号 / 密码`；连接后按账户权限操作 |
| 服务端模式 | 自建服务：设置监听端口、管理账户与密码、配置目录与权限 |
| 权限模型 | 目录白名单 + 可继承的树形权限 |
| 文件传输 | 局域网 P2P 直连，支持断点续传；接收方需确认（默认） |
| 窗口行为 | Windows 关闭时隐藏到托盘/右下角图标 |
| 打包 | Windows (NSIS) 与 Ubuntu (AppImage/deb) 双端安装包 |

### 已明确不做（范围外）

- 公网 NAT 穿透 / 跨公网 P2P：**仅局域网直连**。
- 局域网"自发现"其他使用本软件的机器：**不实现**。
- P2P 的 UDP 发现：**仅用于已授权的传输对端定位**，不对外暴露机器列表。

---

## 2. 技术选型

| 层 | 选择 | 版本 |
|---|---|---|
| 桌面框架 | Electron | 45 |
| 构建 | electron-vite | 6 |
| 前端 | Vue | 3.5 |
| UI 库 | Element Plus + @element-plus/icons-vue | 2.14 / 2.3 |
| 数据库 | better-sqlite3（按 Electron ABI 重编） | 13 |
| 服务端网络 | ws | 8 |
| 打包 | electron-builder | 26 |
| 语言 | TypeScript | 5.9 |

### 依赖源配置

直连 npmjs 在本环境不稳定，使用 npmmirror：

- `.npmrc`：`registry=https://registry.npmmirror.com`
- Electron 二进制：`electron_mirror=https://npmmirror.com/mirrors/electron/`
- electron-builder 二进制：`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
- `postinstall`: `electron-builder install-app-deps`（重编 better-sqlite3）

---

## 3. 目录结构

```
network-p2p/
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ tsconfig.json / tsconfig.node.json / tsconfig.web.json
├─ .npmrc
├─ docs/                        # 设计与计划文档
├─ resources/icons/             # 应用与托盘图标
└─ src/
   ├─ shared/                   # 主进程与渲染进程共用
   │  ├─ protocol.ts            # WS 消息类型、错误码
   │  ├─ permissions.ts         # 权限位定义与树形继承求解
   │  ├─ p2p-frames.ts          # P2P 帧格式（握手/清单/分块/确认）
   │  └─ path-safety.ts         # 白名单路径规范化与穿越防护
   ├─ main/
   │  ├─ index.ts               # app 生命周期、单实例锁、窗口调度
   │  ├─ windows/
   │  │  ├─ floater.ts          # 悬浮球窗口
   │  │  ├─ main-window.ts      # 主窗口
   │  │  └─ tray.ts             # 托盘
   │  ├─ store.ts               # 本地配置 SQLite（连接历史、窗口位置）
   │  ├─ client/                # WS 客户端：连接、重连、请求队列
   │  ├─ server/                # WS 服务端
   │  │  ├─ db.ts               # 账户/白名单/权限/审计表
   │  │  ├─ auth.ts             # scrypt 校验、token、锁定策略
   │  │  ├─ fs-ops.ts           # 目录浏览/读写/重命名/删除/上传
   │  │  ├─ permission.ts       # 服务端强制权限校验
   │  │  └─ service.ts          # 生命周期、端口预检、启停
   │  ├─ p2p/
   │  │  ├─ discovery.ts        # UDP 定位已授权对端
   │  │  ├─ peer.ts             # TCP 连接与握手
   │  │  └─ transfer.ts         # 分块传输、断点续传、校验
   │  └─ ipc.ts                 # IPC 通道定义与注册
   ├─ preload/
   │  └─ index.ts               # contextBridge 暴露 window.api
   └─ renderer/
      ├─ floater/               # 悬浮球界面
      └─ main/                  # 主界面
         ├─ views/
         │  ├─ connect/         # 连接表单
         │  ├─ files/           # 文件浏览与操作
         │  ├─ transfers/       # 传输任务与接收确认
         │  ├─ server/          # 服务端管理（账户/目录/权限）
         │  └─ settings/        # 通用设置
         └─ router.ts
```

---

## 4. 功能设计

### 4.1 悬浮球（Floater）

- 窗口：`transparent + frameless + alwaysOnTop + skipTaskbar`，圆形、可拖动，记住位置。
- 状态：未连接灰色；连接中蓝色脉冲；传输中显示进度环。
- 交互：单击展开主窗口；右键菜单（显示主界面 / 断开 / 退出）。
- 多屏安全：拖动后位置落在可视区域内（防拖出屏幕）。

### 4.2 主窗口

- 未连接：强制弹出 `IP / 端口 / 账号 / 密码` 表单，记住最近连接与端口；密码可选记忆（`safeStorage` 加密），默认不记忆。
- 已连接：按服务端下发的目录树与"有效权限"渲染，无权限操作禁用并提示原因。
  前端禁用仅作提示，**服务端会对每个操作二次校验**。
- 断线：自动重连（指数退避），界面提示状态。
- 关闭行为：Windows 下隐藏到托盘；Ubuntu 同样进托盘，无托盘环境退回悬浮球。

### 4.3 客户端连接

- 鉴权流程：`hello` → 账号密码 → 服务端返回 token 与能力集（可见目录树 + 每目录有效权限）。
- 心跳保活，超时可配。
- 连接历史保存在本地 SQLite，可一键重连、删除。

### 4.4 自建服务端

- 监听端口（默认 47100），启停控制，展示本机局域网 IP 供客户端填写。
- 启动前端口预检：占用时明确提示，可一键"自动选择空闲端口"。
- 账户管理：
  - 用户名、启用/禁用；
  - 密码支持**固定**或**随机生成**（一键复制）；
  - 口令以 `scrypt` 加盐存储，不落明文；
  - 失败登录锁定策略（次数/时长可配）。
- 目录白名单：为账户添加允许访问的目录（绝对路径，服务端 `realpath` 校验）。
- **树形权限**：目录节点默认继承父级，可覆盖；权限位见 4.5。
- 审计日志：登录、写操作、传输授权与结果，落库可查。

### 4.5 权限模型

权限位（每个目录节点可配）：

| 位 | 含义 |
|---|---|
| READ | 浏览/读取目录与文件 |
| WRITE | 修改文件内容 |
| RENAME | 重命名 |
| DELETE | 删除 |
| UPLOAD | 上传到该目录 |
| DOWNLOAD | 从该目录下载 |
| TRANSFER | 发起/接收该目录的 P2P 传输 |

规则：

1. 根节点（白名单目录）配置默认继承集。
2. 子目录默认**继承父级**；可显式覆盖为一组自定义权限位。
3. 求解：沿祖先链合并，最近的显式覆盖生效。
4. 每个文件系统操作前，服务端用"规范化路径是否落在白名单前缀内 + 对应权限位"双重判断。
5. 路径穿越防护：拒绝 `..`、符号链接逃逸、UNC 异常路径。

### 4.6 P2P 传输（局域网）

- 授权：客户端经 WS 向服务端申请；服务端校验账户对目标目录具备 `TRANSFER`/`DOWNLOAD`/`UPLOAD`，返回一次性 **P2P token** 与对端地址。
- 发现：授权后仅探测该对端（不做机器列表）。
- 连接：TCP 直连对端传输端口。
- 帧流程：`HELLO{token, manifestHash}` → `MANIFEST`（文件列表、大小、每文件 SHA-256）→ 64KB 分块交错传输 → `DONE`。
- 校验：流式 SHA-256，逐文件比对。
- 断点续传：按 `sessionId + fileId` 持久化已完成分块位图，失败可续。
- **接收确认（默认开启）**：
  - 接收方收到请求 → 悬浮球红色闪烁 + 托盘通知 + 主界面"待处理传输"横幅。
  - 接受/拒绝；默认 60s 超时自动拒绝（可调）。
  - 可选"自动接收"：仅在磁盘空间足够时接受，否则回落确认。

### 4.7 设置项汇总

| 分组 | 项 | 默认值 |
|---|---|---|
| 服务端 | WS 监听端口 | 47100 |
| 服务端 | P2P TCP 端口 | 47101 |
| 服务端 | UDP 发现端口 | 47102 |
| 服务端 | 广播间隔 | 3s |
| 服务端 | 对端超时 | 10s |
| 传输 | 接收策略 | 需要确认 |
| 传输 | 确认超时 | 60s |
| 客户端 | 密码记忆 | 关闭 |
| 客户端 | 重连退避上限 | 可调 |

所有端口冲突时均支持"自动选择空闲端口"。

---

## 5. 安全要点

- 渲染进程无 Node 权限（`contextIsolation: true`、`nodeIntegration: false`），仅通过 `window.api`（preload 白名单）访问能力。
- 服务端首次监听 `0.0.0.0` 需确认。
- 口令 `scrypt` 加盐；token 短期有效；失败登录锁定。
- 所有路径经 `realpath` + 白名单前缀校验。
- 审计日志覆盖敏感操作。
- P2P token 一次性、限定会话与目录。

---

## 6. 实施步骤

| # | 步骤 | 验收标准 |
|---|---|---|
| 1 | 脚手架与依赖（镜像源配置） | `npm run dev` 启动空壳应用 |
| 2 | 共享模块（协议/权限求解/路径防护/P2P 帧）+ 单元测试 | 单测通过（继承求解、路径穿越用例） |
| 3 | SQLite 层：本地配置库 + 服务端库 | 迁移可执行，表结构就绪 |
| 4 | WS 服务端：鉴权 → 命令 → 权限校验 → 审计 → 端口预检 | 端到端可完成登录与目录浏览 |
| 5 | 客户端：连接、重连、能力下发、按权限操作 | 连接/断线/权限禁用行为正确 |
| 6 | P2P 传输：握手、清单、分块、断点续传、接收确认 | 局域网双向传文件/目录成功，可续传 |
| 7 | 窗口：悬浮球、展开、托盘、Windows 关闭隐藏 | 行为符合 4.1/4.2 |
| 8 | UI 打磨（Element Plus 表格/树/进度/表单） | 主要流程无阻塞 |
| 9 | 设置页（端口/超时/策略）+ electron-builder 打包 | 本机产出 deb/AppImage 并验证 |

### 打包说明

- Ubuntu：本机可产出 AppImage 与 deb 并验证运行。
- Windows：需在 Windows 或 CI（GitHub Actions `windows-latest`）生成 NSIS；仓库提供 `electron-builder.yml` 与 CI 配置。
- better-sqlite3 原生模块需按 Electron ABI 重编（`install-app-deps` 自动处理）。

---

## 7. 已知风险与回退

| 风险 | 影响 | 回退方案 |
|---|---|---|
| 仅局域网，无法跨公网 | 远程办公场景不可直接用 | 借助 VPN/内网穿透后使用 |
| UDP 广播被企业网阻断 | P2P 对端定位失败 | 手动填写对端 `IP:传输端口` |
| 端口被占用 | 服务起不来 | 端口预检 + 自动选空闲端口 |
| Windows 包无法在 Linux 产出 | 交付延迟 | CI 在 Windows runner 打包 |
| 原生模块 ABI 不匹配 | 启动崩溃 | `postinstall` 强制重编；CI 固定版本 |

---

## 8. 待实现时确认的开放项

- P2P 并发分块数与单文件分块大小最终取值（按实测调整）。
- "自动接收"的磁盘空间阈值默认值。
- 托盘/悬浮球图标设计资源。
