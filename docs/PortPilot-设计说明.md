# PortPilot 设计说明

## 1. 目标与约束

把 Clash Verge Rev 订阅里的节点各自开放成一个本地代理端口。用户只做三件事：建/删端口、开/关、选节点。
工具不常驻、无托盘、无服务、无定时轮询；关窗即退出，且退出后已打开的端口继续可用。
界面只用「端口」「节点」「开关」；禁用词：建立、生效、接管、槽位、持久层、脚本层、重载。

## 2. 事实基础（在本机实测确认）

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

选节点（`core.selectNode()`）：`PUT /proxies/PortPilot-<端口>` → 回读 `now` 校验 → 更新 `state.json` → 同步写一次模板（只为把默认值也改成新节点，不动内核）。不重载，不打断已有连接。

## 4.5 无边框窗口（对齐参考项目 Wails 的做法）

- `FormBorderStyle.None` + 保留 `WS_THICKFRAME`，`WM_NCCALCSIZE` 返回 0（客户区铺满整窗）。
- `DwmExtendFrameIntoClientArea(hwnd, {1,1,1,1})`：拿到系统投影与 Win11 圆角，又不显示标题栏，且**窗口四周没有自绘边框**（此前那圈 6px 是我自己画的，已去掉）。
- 非最大化时客户区底部多算 1px（`rgrc.Bottom += 1`）并把 WebView2 底部内边距设为 1px —— 这是 Wails 消除无边框窗口缩放闪白的同一处写法。
- `WM_ERASEBKGND` 直接返回 1（不擦背景），并设置 WebView2 的 `DefaultBackgroundColor` 为主题底色，杜绝缩放瞬间露出白底。
- 缩放不做几何计算：前端在边缘 6px 内按下时，由宿主发 `WM_NCLBUTTONDOWN` + 对应的 HT 码，让系统跑它自己的缩放回路（因此有对齐、贴边等原生行为）。
- 最大化用 `WM_GETMINMAXINFO` 限定到显示器工作区，避免盖住任务栏。

## 5. 界面与宿主的分工

- **宿主（C# / .NET Framework 4.8 / WebView2，约 900 行）**：只做 I/O 原语——命名管道上的裸 HTTP/1.1、文件原子写/备份、TCP 连通性与可绑定性探测、系统深浅色、文件对话框、`clash-verge.yaml` 变化监听（`FileSystemWatcher`，事件驱动）。自带 `--selftest`。
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

## 7. 源码结构

```
build.ps1              下载依赖（Roslyn + WebView2 SDK，已就位则跳过）→ 编译 → 打包 → 自检
src/host/              C# 宿主：Program / MainForm / Bridge / PipeHttp / FileOps / Net / Theme / Dialogs / SelfTest
src/shared/            JS 领域逻辑：util / yamledit / model / state / payload / vergetpl / api / log / core
src/web/               index.html + css/app.css + js（bridge / ui / app / pages/*）
tests/                 node --test 单元测试
tests/e2e-pipeline.js  真机端到端验收（会改内核状态，跑完自动还原）
fixtures/              合成样例，用于单元测试
```

## 8. 真机验收结果

`node tests/e2e-pipeline.js` 16 项全通过：管道发现、内核版本、节点列表、端口空闲、配置组装、应用到内核、端口开始监听、分组生效、默认选中指定节点、切换节点即时生效、HTTP 代理返回 204、CONNECT 隧道可用、连接被标记到该端口、关闭后停止监听、还原原配置。

界面侧人工验收：空状态新建 10801 → 拨开开关（TCP 可连、模板写入并留下备份）→ 搜索「香港」并选节点（内核回读一致、状态显示已保存）→ 通过 10801 代理返回 204 → 关窗后端口继续可用 → 重启 Clash Verge 后重新生成的 `clash-verge.yaml` 里带着 `listeners` 与 `PortPilot-10801` 组，节点选择仍是原来那个。
