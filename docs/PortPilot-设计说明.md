# PortPilot 设计说明

## 1. 目标与约束

把 Clash Verge Rev 订阅里的节点各自开放成一个本地代理端口。用户只做三件事：建/删端口、开/关、选节点。
工具不常驻、无托盘、无服务、无定时轮询；关窗即退出，且退出后已打开的端口继续可用。
界面只用「端口」「节点」「开关」；禁用词：建立、生效、接管、槽位、持久层、脚本层、重载。

## 2. 事实基础

| 事实 | 结论 |
| --- | --- |
| 控制通道 | mihomo 的命名管道。配置里写的是 `\\.\pipe\verge-mihomo-sidecar-release-<hash>`（连不上），实际可连的是同 hash 的 `production-` 变体 |
| 每端口入站 | 内核支持顶层 `listeners:`（`config.RawConfig.Listeners []map[string]any` → `listener.ParseListener`）。`type: mixed` 支持 `name/listen/port/proxy/udp`；`proxy` 即 `SpecialProxy`，连接在 `tunnel.resolveMetadata` 直接走该代理，**绕过规则**；`metadata.inboundName` 会带上监听器名 |
| 应用监听器 | 没有 `/listeners` 接口。只有 `PUT /configs`：`{"payload":"完整配置文本"}` 或 `{"path":"内核 home 内的绝对路径"}`。`updateListeners` 每次都 `PatchInboundListeners(dropOld=true)`，所以删掉条目＝真正停止监听。解析失败返回 400 且不改动运行状态 |
| 选节点 | `PUT /proxies/{组名}` `{"name":"节点名"}` → `selector.Set()` + `cachefile.Cache().SetSelected()`；`profile.store-selected: true` 时每次应用配置都会 `patchSelectGroup` 还原。**不需要写文件，也不需要重载** |
| 每端口汇总 | `GET /connections` 的连接带 `metadata.inboundName` / `inboundPort` / 上传下载 |
| Verge 生成链 | `process_seq_items`（rules/proxies/**groups** 模板）→ 默认配置合并 → 内置脚本 → `use_tun` → DNS → **全局 Merge.yaml** → **订阅自身的 merge/script** → 控制面强制 → `cleanup_proxy_groups` → `use_sort` |
| 可安全写入的位置 | ① 订阅的 merge 模板（`option.merge`）：`use_merge` 对不存在的键直接插入 → 放 `listeners`；② 订阅的 groups 模板（`option.groups`）：`SeqMap{prepend,append,delete}`，**三个键必须同时存在** → 放每端口的组 |
| 不会被误删 | `listeners` 不在控制面键列表里，`use_sort` 也不丢键；`cleanup_proxy_groups` 只裁剪组内 `proxies` 里不存在的名字，因此节点失效时组会自动回退到 include-all 的候选列表 |

## 3. 数据模型

`state.json`：

```json
{ "version": 1,
  "ports": [ { "port": 10801, "enabled": true, "node": "🇭🇰3香港集群-全网优化(M)" } ],
  "settings": { "theme": "system", "testUrl": "http://cp.cloudflare.com/generate_204",
                "watchConfig": true, "startPort": 10801 },
  "lastBackup": { "stamp": "...", "backups": { "<目标文件>": "<备份文件>" } } }
```

组名与监听器名统一派生为 `PortPilot-<端口号>`；改端口号时整体重写并重新推送节点选择。

## 4. 一次操作的完整流程

`applyAll()`（建端口、删端口、改端口号、开/关、导入都走它）：

1. 校验：端口号范围与重复、不等于内核自身端口、已选节点必须还在节点列表里（不在只提示不阻塞）。
2. 读 `clash-verge.yaml` 全文，用 `payload.compose()` 组装新配置：
   - 剔除上一轮注入的 `# >>> PortPilot` / `# <<< PortPilot` 区块（保证幂等）；
   - 注释标记会被 Clash Verge 的 YAML 往返丢掉，所以除了标记，还要**按名字**（PortPilot-<端口号>）清掉配置里已经存在的监听器与分组，否则重新打开/关闭端口时内核会报 duplicate group name；
   - 把每端口的 `select` 组插进 `proxy-groups` 之后；
   - 把已打开端口的 `listeners` 条目插进 `listeners` 键（没有就新建）。
3. `PUT /configs` 应用。**这一步是唯一的风险点**：失败（400）时内核状态没有变化，直接报错返回，不写文件。
4. 成功后才落盘：把同样的内容写进订阅的 merge 模板与 groups 模板（先复制到 `backup/<时间戳>/`，再原子写，最后回读校验）。
5. 若第 4 步失败：还原两份模板 + 把内核退回上一次成功的配置文本，报错并记录。
6. 用 TCP 连接探测每个已打开端口，把真实结果作为「状态」；不一致就显示「打开失败」。
7. 保存 `state.json`，写运行记录。

选节点（`core.selectNode()`）：`PUT /proxies/PortPilot-<端口>` → 回读 `now` 校验 → 更新 `state.json` → 同步写一次模板（只为把默认值也改成新节点，不动内核）。不重载，不打断已有连接。例外：新建端口还没应用过（组不在内核，`PUT` 回 404）时，自动走一次 `applyAll()` 把监听器与分组建出来，选中节点作为组默认值一起生效。

## 4.5 无边框窗口

- 窗口由 Wails v2 以 `Frameless: true` 创建，并保留默认的 `DisableFramelessWindowDecorations: false` —— 于是照样有系统投影与 Win11 圆角，而没有标题栏。
- 起始底色由 `BackgroundColour` 按当前系统主题给出（读注册表决定浅/深），避免打开瞬间闪白底。
- 拖动：前端在 `[data-drag]` 区域按下时调用 `window.beginDrag`，宿主取本进程主窗口句柄后发 `WM_NCLBUTTONDOWN` + `HTCAPTION`，让系统跑它自己的拖动回路。
- 缩放：前端在边缘 6px 内按下时调用 `window.beginResize` 并带上方位，宿主换算成对应的 HT 码后同样发 `WM_NCLBUTTONDOWN`（因此有对齐、贴边等原生行为）。
- 最小化/最大化/关闭走 Wails 运行时（`WindowMinimise` / `WindowMaximise` / `Quit`）。

## 5. 界面与宿主的分工

- **宿主（Go + Wails v2，单文件 exe）**：只做 I/O 原语——命名管道上的裸 HTTP/1.1（`pipehttp.go`）、文件原子写/备份（`fileops.go`）、TCP 连通性与可绑定性探测（`netprobe.go`）、系统深浅色（`theme.go`）、系统对话框（`dialogs.go`，走 Wails 运行时）、窗口拖动与缩放（`win.go`）、`clash-verge.yaml` 时间戳监听（`app.go`）。自带 `--selftest`。
- **单文件 exe 的来源**：`main.go` 用 `//go:embed all:src/web` 把界面编进二进制——产物只有一个 exe，不需要旁边的 DLL 或 web 目录。
- **前端接口**：`bridge.go` 的 `App.Call(method, params)` 是前端唯一入口，方法名与返回结构固定；`src/web/js/bridge.js` 只把 `invoke` 转发给 Wails 绑定，`src/shared` 与各页面不感知传输层。
- **前端（HTML/CSS/JS，无打包器、无 npm 依赖）**：领域逻辑（状态模型、期望的监听器与分组、配置文本组装、模板读写）都在 `src/shared/`，浏览器与 Node 单测共用同一份代码。
- **状态唯一来源**：`core.view()` 把「开关＝用户意图」「状态＝TCP 探测结果」「节点＝state.json + 内核回读」集中算一次，七个页面全部渲染它，不存在两个页面说法不一致。

## 6. 失败模式与对策

| 情况 | 处理 |
| --- | --- |
| Clash Verge 未运行 / 管道找不到 | 候选顺序：配置里的管道名 → 换成 `production-` → 换成 `sidecar-release-` → 枚举所有 `*mihomo*` 管道逐个 `GET /version` |
| 端口号被占用 | 预检 TCP+UDP 试绑；内核绑定失败只记日志不返回错误，所以最终以 TCP 探测为准 |
| 内核静默失败 | 同上，一律以真实探测结果作为状态并给出原因 |
| 节点在订阅更新后消失 | 该端口标「节点已失效」，组因 `include-all-proxies` 仍可用，其余端口不受影响 |
| 订阅切换（Verge 里换 profile） | 两份模板属于订阅，端口随新的当前订阅重建；工具运行时会监听 `clash-verge.yaml` 变化并自动补一次 |
| 用户在 Verge 界面改写了模板 | 每次写入前备份、启动时自愈；`option.merge`/`option.groups` 为空时会自动新建条目并改 `profiles.yaml` |
| 配置文件里已有别人的 `listeners` | 不覆盖，把我们的条目插进同一个键 |
| 启动失败（无控制台，`windowsgui`） | 错误同时写日志与弹框，绝不静默退出（`report.go`）。日志按 `%APPDATA%` → `%LOCALAPPDATA%` → exe 同目录依次找可写位置 |
| 缺 WebView2 运行时 | 启动前 `preflight` 先查（目录 + 注册表兜底），缺失时弹中文说明并给出下载页，而不是让 Wails 内部报错退出 |
| WebView2 数据目录不可写 | 按 `%APPDATA%` → `%LOCALAPPDATA%` → `%TEMP%` → exe 同目录依次回退，日志记录实际用的那一个（`preflight.go`） |
| 同名文件挡在数据目录处 | 先改名为 `<目录>.blocked` 再建目录，不让启动卡死 |
| 双击被系统当不可信程序 | 构建后清除下载标记（`Unblock-File` + 删 `Zone.Identifier`），并把目录完整性标签校正为 Medium（`build.ps1`） |

## 7. 源码结构

```
build.ps1              准备界面资源 → 生成图标/版本/DPI 资源 → go build → 校验 → 自检
main.go                Wails 入口：go:embed 界面 + 无边框窗口选项
app.go                 应用生命周期：系统主题与 clash-verge.yaml 变化 → 事件推给前端
bridge.go              App.Call 分发（前端唯一入口）
pipehttp.go            命名管道上的 HTTP/1.1（发现管道、分块解码、超时）
fileops.go             文件原语：读、原子写、备份、还原
netprobe.go            端口连通性与可绑定性探测
theme.go               系统深浅色（注册表）
dialogs.go             系统对话框（Wails 运行时）
win.go                 窗口拖动/缩放与进程探测
preflight.go           启动前检查：WebView2 运行时、数据目录可写性（含回退）
report.go              日志与错误上报：写文件 + 弹框，启动失败绝不静默
paths.go               路径约定（AppData / 备份 / 日志 / Verge 数据目录）
selftest.go            --selftest 自检
build/windows/         图标、版本信息、DPI 清单
build/winresgen/       把上面三者编成 wails_winres_amd64.syso
src/shared/            JS 领域逻辑：util / yamledit / model / state / payload / vergetpl / api / log / core
src/web/               index.html + css/app.css + js（bridge / ui / app / pages/*）
tests/                 node --test 单元测试
tests/e2e-pipeline.js  真机端到端验收（会改内核状态，跑完自动还原）
fixtures/              合成样例，用于单元测试
```

> `src/web/shared/` 是构建脚本从 `src/shared/` 复制生成的（`go:embed` 只能嵌入 `src/web` 之下的文件），已在 `.gitignore` 中，不要手工编辑。

## 8. 验收

`node tests/e2e-pipeline.js` 16 项全通过：管道发现、内核版本、节点列表、端口空闲、配置组装、应用到内核、端口开始监听、分组生效、默认选中指定节点、切换节点即时生效、HTTP 代理返回 204、CONNECT 隧道可用、连接被标记到该端口、关闭后停止监听、还原原配置。

界面验收：新建 10801 → 打开开关（TCP 可连、模板写入并留下备份）→ 搜索并选节点（内核回读一致、状态显示已保存）→ 通过 10801 代理返回 204 → 关窗后端口继续可用 → 重启 Clash Verge 后重新生成的 `clash-verge.yaml` 里带着 `listeners` 与 `PortPilot-10801` 组，节点选择保持不变。
