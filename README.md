# v-Lattice

基于 **Electron + Element Plus + SQLite** 的双模式文件工具：既可连接远程文件服务，也可自建服务端；文件/目录传输采用**局域网 P2P 直连**。

支持 Windows 10+ 与 Ubuntu 24.04+。

## 功能

- **圆形悬浮球**：始终置顶、可拖动，点击展开主界面；状态指示（未连接/连接中/已连接/传输进度/待接收闪烁）。
- **客户端模式**：未连接时提示输入 `IP / 端口 / 账号 / 密码`；连接后按账户的目录与权限操作。
- **自建服务端**：
  - 可设置监听端口（WS 47100 / P2P 47101，均可在设置中调整）；
  - 账户管理：密码可固定或**随机生成**，支持启用/禁用、失败锁定；
  - 目录白名单 + **可继承的树形权限**（读取/写入/重命名/删除/上传/下载/传输）。
- **P2P 传输**：UDP/TCP 局域网直连，需接收方确认（默认开启，可设自动接收），支持断点续传与 SHA-256 校验。
- **窗口行为**：Windows 关闭时隐藏到右下角托盘；退出请用托盘菜单。
- **审计日志**：登录、写操作、传输授权均有记录。

## 技术栈

| 层 | 选择 |
|---|---|
| 桌面 | Electron 45 + electron-vite 6 |
| 前端 | Vue 3.5 + Element Plus 2.14 |
| 数据库 | better-sqlite3 13（按 Electron ABI 重编） |
| 网络 | ws 8（WebSocket）+ 自研 P2P 协议 |
| 打包 | electron-builder 26 |

## 开发

```bash
npm install          # 会自动重编 better-sqlite3
npm run dev          # 启动开发模式
npm run typecheck    # 类型检查（主进程 + 渲染进程）
npm test             # 单元 + 集成测试（30 项）
npm run build        # 构建产物到 out/
```

> 依赖使用 npmmirror 镜像，见 `.npmrc`。若 Electron 运行时未下载，执行：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`

### Linux 无沙箱/无 GPU 环境运行

```bash
ELECTRON_DISABLE_SANDBOX=1 ./node_modules/.bin/electron out/main/index.js --no-sandbox --disable-gpu
```

## 打包

```bash
npm run dist:linux   # AppImage + deb（本机可验证）
npm run dist:win     # NSIS（需在 Windows 或 CI 的 Windows runner 上执行）
```

Windows 安装包请使用 `.github/workflows/build.yml` 中的 CI 配置，或直接在 Windows 上运行 `npm run dist:win`。

## 目录结构

```
src/
├─ shared/          # 主进程与渲染进程共用：协议、权限求解、路径防护、P2P 帧
├─ main/            # 主进程：窗口、服务端、客户端、P2P、SQLite
│  ├─ server/       # WS 服务端（鉴权、文件操作、权限校验、审计）
│  ├─ client/       # WS 客户端（连接、重连、请求队列）
│  └─ p2p/          # P2P 传输（握手、清单、分块、校验）
├─ preload/         # contextBridge 暴露 window.api
└─ renderer/        # 悬浮球 + 主界面（Vue + Element Plus）
```

## 权限模型

权限位：`READ | WRITE | RENAME | DELETE | UPLOAD | DOWNLOAD | TRANSFER`

- 每个账户绑定若干目录白名单（根节点）；
- 子目录默认**继承父级**，可显式覆盖；
- 求解时沿祖先链合并，**最近的显式覆盖生效**；
- 所有文件操作前服务端做「路径白名单校验 + 权限位校验」双重判断。

## 已知限制

- 仅支持局域网；跨公网需借助 VPN/内网穿透。
- UDP 广播在部分企业网可能被阻断，P2P 会回退为直连 IP 方式。
- Windows 安装包需在 Windows 环境或 CI 上生成。

## 文档

- [设计方案与实施计划](docs/PLAN.md)

## 许可证

MIT
