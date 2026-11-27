# IP 段检测

- 归档日期：2026-11-27
- 类型：需求开发（need）
- 来源：AI 开发会话（工作区连接表单增强需求）
- 梳理汇入时间：2026-11-27 13:37

## 用户提示词

> 新增IP端检测服务功能，在工作区连接时输入IP提供检测功能，点击检测弹出窗口，自动识别本机IP并生成IP段，用户选择IP段，点击检测，加入IP和默认端口对的上，服务端给检测的客端返回一个确认数据，窗口则显示这个IP可连接，用户双击IP和端口默认填入表单

## 实际需求梳理

在工作区「新建连接」处新增 IP 段检测服务功能：

1. 连接表单提供「检测」入口（输入 IP 旁），点击弹出检测窗口
2. 窗口自动识别本机 IP 并按网卡掩码生成所在网段（IP 段），多个网卡时由用户选择
3. 点击「检测」后对该网段内所有 IP 的默认端口（47100）做并发探测
4. 服务端收到探测请求后需返回一个确认数据；客户端只有收到该确认数据才判定「IP + 默认端口对得上」→ 窗口显示该 IP「可连接」（端口开放但服务不匹配不误报）
5. 用户双击「可连接」的 IP 行，IP 与端口默认填入连接表单，关闭弹窗

歧义点澄清：「IP端检测」理解为「IP 段检测」（按网段批量探测）；「IP和默认端口对的上」理解为收到服务端确认数据才算可连接，而非仅 TCP 端口开放。

## 解决方案

- **探测协议**：复用服务端已有的 HTTP server（WS 挂在其上），给非 WS 升级的 HTTP 请求（探测端 GET /probe）返回确认 JSON `{ service: 'v-lattice', hostname, protocolVersion }`；探测端校验 `service === 'v-lattice'` 才判 alive
- **网段生成**：`os.networkInterfaces()` 取 IPv4 非回环网卡，掩码转前缀位数推导 CIDR；掩码宽于 /24（如 /16）时收敛到地址所在 /24，避免一次探测数千地址
- **探测执行**：`http.get` 1.2s 超时，每批 32 个并发分批执行；ECONNREFUSED→「端口未开放」、超时→「连接超时」等具体错误原因落结果表
- **UI**：新建连接弹窗 IP 输入框 append 槽放「检测」按钮；检测弹窗含网段下拉（`192.168.1.0/24（本机 192.168.1.5）`）+ 端口输入（默认取当前表单端口）+ 结果 el-table（双击 alive 行回填 `form.host`/`form.port` 并关窗）；弹窗按页面 ID 体系注册固定 ID `a001b002`（`workspace::ip-scan`）

## 涉及文件

- `src/shared/protocol.ts` — 新增 `LocalNic` / `ProbeResult` / `ProbeRangeParams` 类型
- `src/main/net-probe.ts` — 新建：`localNics()` / `expandRange()` / `probeHost()` / `probeRange()`
- `src/main/server/service.ts` — `start()` 的 http server 加探测确认响应（hostname + PROTOCOL_VERSION）
- `src/main/index.ts` — 注册 `net:localNics` / `net:probe` IPC
- `src/preload/index.ts` — 暴露 `api.net.localNics()` / `api.net.probe()`
- `src/renderer/src/main/views/WorkspaceView.vue` — 「检测」按钮 + 检测弹窗 + 双击回填（openScan / startProbe / pickIp）
- `src/renderer/src/composables/usePageRegistry.ts` — FIXED_DIALOG_IDS 登记 `workspace::ip-scan: a001b002`

## 验证结论

- typecheck（node + web）0 错误
- 测试 54/55 通过；唯一失败的 S8（接收端暂停后继续）为 700ms 时序抖动用例，单独重跑即通过，与本功能无关（本功能只加 HTTP 确认响应，不涉及 P2P 暂停链路）
- 改动未提交 git
