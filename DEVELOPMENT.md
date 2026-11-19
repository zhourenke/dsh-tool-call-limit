# 开发注意事项（Development Notes）

面向维护者。使用者请看 [README.md](README.md)——那里只回答"能不能用、怎么调、哪里会踩坑"，实现内部细节一律放在本文档。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `src/index.ts` | 全部实现，单文件 |
| `lib/index.js` | 编译产物，**必须提交**（路线 A） |
| `lib/types/index.d.ts` | 类型声明，**必须提交** |
| `test/core.test.mjs` | 对编译产物的执行测试（当前 22 项） |
| `cordis.patch.yml` | profile 层插入声明 |
| `locale/{en,zh}.json` | 插件列表的显示元数据（名称与说明，DSH 0.1.7 起） |
| `icon.svg` | 插件列表图标；宿主读成内联 data URL |

## 本地开发与构建

```powershell
pnpm install        # 安装开发依赖
pnpm run typecheck  # 类型检查
pnpm run build      # 编译到 lib/
pnpm test           # 先构建，再执行 lib/ 产物
```

> **本仓的 PowerShell 命令不依赖 shell 版本，不必随换版复核。** 三条命令块（构建、连接点、装载期自检）在 **pwsh 7.6.6（`Core`）** 与 **Windows PowerShell 5.1.26100.9168（`Desktop`）** 上 A/B 实测输出一致——它们只用两版共有的语法（`-replace`、`Join-Path`、`New-Item -ItemType Junction`、`[System.IO.Directory]::CreateDirectory`）。主指南「本环境的 PowerShell 版本基线」里那批"换版即作废"的结论（`Get-Content` 的默认读法、`>` 的落盘编码、`&&` 不可用…）都落在**读写的编码与语法糖**上，本仓不含这类写法；`$PSVersionTable` 自证仍是动手前的第一步。

**每次修改 `src/index.ts` 后必须运行 `pnpm run build`，并把 `lib/` 一并提交。**

`pnpm test` 不是可选项。`tsc` 只做类型检查与转译，漂移检查只看 git 状态——**没有任何一步执行过产物**。于是「模块在 import 时抛错」可以一路绿灯，直到用户重启 DSH 才在启动日志里爆出来。测试直接 `import` 编译产物，用模拟 ctx 走一遍加载、事件注册与配额判定。

`test` 脚本写作 `"pnpm run build && node --test"`，两点都不能省：`node --test` 不带参数才会递归发现全部测试文件（`node --test test` 与 `node --test test/` 在 Node 25 下都报 `MODULE_NOT_FOUND`）；串上构建则保证执行的永远是源码当前编译出的产物，而不是上一次的残留。

## 开发挂载：让 DSH 加载你改的代码

用目录连接点把插件挂进 profile 的 `node_modules`，改完 `pnpm run build` 再重启即可，不必每次重新安装：

```powershell
[System.IO.Directory]::CreateDirectory("$prof\node_modules\@zhourenke") | Out-Null
New-Item -ItemType Junction -Path "$prof\node_modules\@zhourenke\dsh-tool-call-limit" -Target $PWD
```

**连接点会绕过 profile 里已提升的依赖**：Node 按 realpath 解析后沿工作区路径向上找 `node_modules`，所以插件目录里必须自己 `pnpm install` 一份，否则启动时报 `Cannot find package '@deepseek-ai/schemastery'`。

注意连接点挂载的插件**无法用 `dsh plugin remove` 卸载**（它不在 profile 的 `dependencies` 里），需要手工删连接点再摘掉 `dsh.profile.bundles` 条目。

## 实现要点（为什么这样做）

### 1. 配额必须在 `next()` **之前**同步预占

```ts
const used = state.used.get(exec.name) ?? 0
if (used >= max) return Promise.resolve({ kind: 'deny', reason: … })
state.used.set(exec.name, used + 1)   // 预占
return next()
```

`tools/pre-execute` 是 waterfall，下游策略可能 `await`。**把预占挪到 `next()` 之后，同一个 step 里的兄弟调用就会在下游 await 期间进入本监听器**，于是两个并行调用都会读到同一个剩余名额，双双放行——`web_search: 1` 就形同虚设。JS 不会在 `Map` 的读与写之间交错另一个监听器，所以"读-判-写"三步同步完成即是正确的并发原语。

这是本项目最容易写错、且**测试之外很难发现**的一处。

### 2. 两个扩展点都要 `{ prepend: true }`

`agent/pre-step` 与 `tools/pre-execute` 都注册在最前面：step 状态必须先于其它监听器建立，配额判定必须先于其它策略（否则下游已经拒绝过的调用仍会消耗名额，或被别的监听器抢先放行）。

### 3. 状态用 `WeakMap<Agent, StepState>`，键是 live Agent 对象

不把状态挂到 Agent 上，也不用全局 `Map`（那会让 Agent 无法回收）。`WeakMap` 还带来一个必要性质：**状态私有于当前插件 fiber**，profile 用 `patchReload: live` 重载时，新配置实例不会复用旧实例留下的预占。

### 4. fail-closed 只对**已配置**的工具生效

`limits.get(exec.name)` 为 `undefined` 时直接 `next()`——未配置的工具**完全在本插件的策略之外**。这一点让无 Agent 的内部调用（如宿主自身发起的工具调用）不会被误伤。只有配置了配额的工具才会因缺少 Agent（`requires an agent context`）或缺 step 状态（`has no active agent step`）而被拒绝。

### 5. 状态清理有五条路径，且都要带同一性判断

| 时机 | 处理 |
|---|---|
| `agent/pre-step` 的 `next()` **同步抛错** | 删除本次建立的 state |
| `agent/pre-step` 的 promise **reject** | 同上 |
| `agent/pre-step` 返回 `kind: 'reject'` | 被否决的 step 不会成为 active step，删除 |
| `agent/turn-stopping` | `state.turn === turn` 时删除 |
| `agent/error` | `state.turn === turn && state.step === step` 时删除 |
| `agent/disposed` | 无条件删除 |

每条删除都判 `states.get(agent) === state` **同一性**，而不是直接 `delete(agent)`：一个更新的 step 可能已经写入，无条件删会把新 state 误删。Cordis 在 fiber 卸载时自动移除事件监听器，无需手工注销。

### 6. `limits` 必须防原型污染

工具名由用户提供，而 `__proto__`、`constructor`、`toString` 都是合法的工具名可能取值。因此：

- 只接受**普通记录**（原型为 `Object.prototype` 或 `null`，且非数组）；
- 写入时用 `Object.defineProperty`，绕开遗留的 `Object.prototype.__proto__` setter；
- 校验结果**复制进 `Map`** 供热路径查询，而不是拿原对象直接 `lookup`；
- `*` 显式报错（`wildcard limits are not supported`），不做通配——**schema 与 `resolveLimits()` 两层都拦**（见下一节末段）。

### 7. 配置校验选择"拒绝未知字段"

未知字段抛 `unknown configuration field(s): …` 而不是忽略。配置只有 `limits` 与 `onExceeded` 两个字段，静默忽略只会让拼错的字段名变成一条永不生效的规则——那比报错难查得多。

`resolveLimits()` 里还有一道 `Number.isSafeInteger(limit) && limit >= 0` 的复查，且**是抛错而不是跳过**：schema 已经校验过，但**直接以编程方式调用 `apply()`** 可以绕过 schema。跳过非法条目会让那个工具变成"不限"——插件看起来装了却在静默放行，与"限速器悄悄不工作"是同一类故障。抛错位置在注册任何监听器之前（`apply` 的第一行），所以被拒的配置不会留下半注册的插件。

同一道复查也覆盖 `*` 通配符键。原先只有 schema 拦它，程序化传入 `{limits: {'*': 1}}` 会被接受并存成一条**名为 `*` 的工具配额**，而没有任何调用会匹配这个名字——配额看起来配好了，却永不生效。加上这道检查后两层对 `*` 的处置一致，也与 README「不支持 `*` 通配符」的承诺对齐。

> 实测：本插件的 schema 用 `z.natural()`（带整数校验），`NaN` 会被 `expected number multiple of 1 but got NaN` 挡下——「`NaN` 能穿过 `z.number()`」那个洞只在只有 `.min()`/`.max()` 而无整数约束时成立。这道守卫兜的是绕过 schema 的那条路径。

### 8. `onExceeded: "ask"` 走宿主 0.2.0 的审批通道，且**不预占名额**

DSH 0.2.0 给 `PreToolDecision` 增加了 `{ kind: 'ask', reason?, displayReason? }`：它交给组合中的审批服务，用户批一次则这一次执行，否则拒绝；**没有可用的审批通道时它本身就退化为拒绝**。本插件把它接成 `onExceeded: 'ask'` 的 opt-in 选项，默认仍是 `'deny'`——老行为一字未变。

两处是刻意的：

- **`ask` 分支不预占名额。** 审批结果在本监听器返回**之后**才落定，此时无从得知是否获批；预占会让"用户拒绝"也吃掉一个名额。所以计数器只统计**自动放行**的调用，超额之后每一次都由用户单独授权——这正是 `ask` 的语义，也意味着配额不会因为批准而被悄悄抬高。
- **它只影响第一条失败路径。** 缺少 Agent 上下文或没有有效 step 时仍然 fail-closed：`ask` 需要一个可归属的 Agent 才能把审批请求路由给人，宿主自己的沙箱升级路径同样要求 `approval.agent !== undefined`。

schema 用 `z.union([z.const('deny'), z.const('ask')]).default('deny')`（实测报错文本为 `expected "deny" | "ask" but got "bogus"`），并且和 `limits` 一样，在注册任何监听器之前对**编程调用**再复查一次。

## 测试要点

- 直接 `import '../lib/index.js'`，断言模块契约（`name` / `inject` / `apply` / `Config`）
- 用模拟 ctx 调一次 `apply`：这是唯一能覆盖事件注册路径的办法
- **并行预占**：同一个 step 内两次 `tools/pre-execute`，断言只放行一个——这是第 1 条实现要点的回归测试
- **Agent 隔离**：两个不同 Agent 各自拿到完整配额
- **配额重置**：进入新 step 后计数清零
- **上下文缺失**：无 Agent、无 step 状态时的两条 fail-closed reason
- **生命周期清理**：`reject` / `turn-stopping` / `error` / `disposed` 后状态确实被移除
- **原型敏感工具名**：`__proto__`、`constructor`、`toString` 作为工具名能正常配置与计数
- **非法配额 fail-loud**：直接调 `apply()` 传 `NaN` / `1.5` / `-1` / 超安全整数时抛错，且 `on()` 一次都没被调用——不留半注册状态
- **非普通对象 `limits` fail-loud**：`Map` / 数组 / 字符串同样抛错且不注册（`Map` 若不拦会因 `Object.keys` 为空而变成"全部不限"的静默 fail-open）
- **`*` 通配符 fail-loud**：`Config` 与直接调 `apply()` 都抛 `wildcard limits are not supported` 且不注册（只拦一条路径时，另一条会静默装进一条永不匹配的配额）
- **`onExceeded` 两种取值**：`ask` 下超额返回 `kind: 'ask'` 且两种 locale 的 `displayReason` 都在；默认与显式 `deny` 都返回原来那条 deny；非法取值在注册前抛错
- **peerDependencies 与 README 强一致**：断言所有宿主 peer 范围一致，且与中英文 README 中的兼容性声明逐版本一一对应

## 发布纪律

- **`lib/` 必须提交，且与 `src/` 同一次提交。** `dsh plugin add github:...` 只接收 git 跟踪的文件，本仓库不在安装时构建，所以产物不同步会让 GitHub 安装静默运行旧代码。
- **不要添加 `prepare` 脚本。** git 托管的包会在安装时执行它，而 pnpm 默认拦截依赖的构建脚本，这会让 `dsh plugin add` 直接失败，直到用户手动在 profile 的 `pnpm-workspace.yaml` 中放行。
- **`files` 只列不会被自动包含的产物。** 当前为 `lib/index.js`、`lib/types/**/*.d.ts`、`cordis.patch.yml`、`icon.svg`、`locale/*.json`。`package.json` / `README*` / `LICEN[CS]E*` 以及 `main` 指向的文件无论如何都会装上，列了是空操作；而 `types`、`exports`、`icon` 与 `locale/*.json` 的目标**不在**自动包含集里，漏出 `files` 就会被静默丢弃——插件照常加载，只是没有类型、没有图标、没有名称。
- 新增产物（第二入口、运行时读取的数据文件）时，必须同步放宽 `files`，并用 `pnpm pack --dry-run` 核对真实载荷。

## 显示元数据与准入闸门（DSH 0.1.7 起）

0.1.7 新增两条**不执行插件代码**的宿主读取路径，两者都极易假绿，各需一条专门的自检：

| 路径 | 宿主函数 | 失败模式 |
|---|---|---|
| 准入闸门（装载期） | `evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)` | 判定失败 → 该 bundle 记入 `skippedBundles` 并抛错 |
| 显示元数据（装载前） | `readPluginMeta(specifier, parentURL)` | 返回 `undefined`，**不报错**；插件照常工作，只是列表里没有名字 |

```powershell
$cwdU = $PWD.Path -replace '\\','/'
$dshU = "<DSH 安装目录>\node_modules\@deepseek-ai" -replace '\\','/'
# 闸门：用的就是装载时那一次判定
node -e "import('file:///$dshU/dsh-app-boot/lib/index.js').then(b => { const m = JSON.parse(require('fs').readFileSync('$cwdU/package.json','utf8')); const i = b.evaluatePluginCompatibility(m, undefined, b.getDshRuntimeVersion()); console.log(i ? 'CONFLICT: ' + b.pluginCompatibilityWarning(i) : 'COMPATIBLE'); })"
# 元数据
node -e "import('file:///$dshU/dsh-app-boot/lib/index.js').then(async b => { const p = require('path'), u = require('url'); const parent = u.pathToFileURL(p.join(process.env.USERPROFILE, '.dsh/profiles/web/package.json')).href; const n = JSON.parse(require('fs').readFileSync('$cwdU/package.json','utf8')).name; console.log(JSON.stringify(b.readPluginMeta(n, parent))); })"
```

2026-09 对 **0.2.0-rc.2** 的实测结果分别是 `COMPATIBLE`，以及含 `title`/`description`/`icon` 的对象（图标已解析成内联 data URL）。

**元数据为什么必须单列一条**：它由宿主在**装载之前**直接读包内文件取得，因此任何运行时测试都覆盖不到——`apply` 的用例全绿，插件列表里照样可能没有名字。反过来，它失败时插件本身照常工作，症状只出现在界面上。

要点：

- `parentURL` 必须是**插件实际解析得到的那棵树**的基址；给错目录时返回 `undefined` **而不是报错**，所以断言要查"返回值里有没有 `title`/`description`/`icon`"，只看"有没有抛错"会假绿。
- `locale/*.json` 必须显式声明 `exports` 子路径（`"./locale/*.json": "./locale/*.json"`）——资源解析走 `exports`。
- `title` / `description` 为空或非字符串是**抛错**；图标失败只保留显示文字。两者失败模式不对称。
- `icon.svg` 与 `locale/*.json` 都不在 `files` 的自动包含集里，必须自己列上。
- 闸门的 `includePrerelease: true` 比范围本身宽松得多：它拦不住"忘了跟着宿主升级的范围"（`^0.1.5-rc.1`、`~0.1.5-rc.1` 都照样通过），只拦跨 minor 的硬漂移。**范围对齐仍要人工做**，闸门只是兜底。本次是反例：`^0.1.7-rc.2` 对 `0.2.0-rc.2` 会被拦下，所以这一版**必须**改范围；而如果宿主只是 `0.2.0-rc.1` 走到 `rc.2`，闸门就会放行，范围改不改它都不报。

## DSH 0.2.0-rc.2 复核结论

本插件依赖的五个扩展点与两个决策类型**逐字未变**：`agent/pre-step`（waterfall，载荷含 `agent`/`turn`/`step`）、`tools/pre-execute`（waterfall，`(exec, next) => Promise<PreToolDecision>`）、`agent/turn-stopping`（serial）、`agent/error`（emit）、`agent/disposed`；`PreStepDecision` 仍有 `kind: 'reject'`，`PreToolDecision` 的 `deny` 分支仍是 `{ kind: 'deny'; reason: string; info?: ToolErrorInfo }`，`ToolExecution` 仍是 `extends ToolExecutionInput`（`name` 必填、`agent` 可选）。

0.2.0 新增的能力与本插件**没有交集**，因此没有"改用宿主机制"的落点：

| 新增能力 | 为什么本插件不用 |
|---|---|
| `ToolDefinition.timeoutMs` + `dsh-tool-call-timeout-policy` | 本插件不定义工具、不执行工作，没有可声明的预算 |
| `dsh-spill-policy` + `ctx.spillStore` | 本插件不产生工具结果正文 |
| `tools/execute`（只能替换 `exec.signal` 的那条 wrapper 缝） | 本插件在 `tools/pre-execute` 上做准入判定，不包装执行 |
| 沙箱族（`dsh-sandbox*` / `dsh-fs-sandbox` / `dsh-pwsh-sandbox`） | 本插件不 spawn、不读写文件 |
| `PreToolDecision` 的 `ask` | **有交集**，已接成 opt-in，见「实现要点」第 8 条 |

**"官方是否已实现"的复核判据**（本次实测，搜索范围是 `dsh-*` 全量 `lib/**/*.js`）：搜 `maxToolCalls|toolCallLimit|maxCallsPerStep|callsPerStep|perStepLimit|toolBudget|callBudget`，**命中 0**。`dsh-repeat-tool-reminder` 仍只挂 `tools/post-execute` 与 `agent/pre-step`（`tools/pre-execute` 命中 0），README 仍写明 "The reminder is advisory: it never blocks or delays a legitimate repeated call"。唯一统计工具调用的包是 `dsh-compaction`，它数的是 `inProgressToolCalls`，用于会话回放时**把工具调用与结果配对平衡**，与配额无关。

`tools/pre-execute` 上的官方监听器只有一个：`dsh-workspace-changes`（记录器，读 `exec.agent?.session`）。权限与审批体系**不在这条缝上**——`dsh-permission-presets` 与 `dsh-user-approval` 挂的是 `internal/dispatch` 与 `session/created`。

### 实测：0.2.0-rc.2 上运行的真实结果

重启后在**一个 step 内同批**发出 `web_fetch` + `web_search` ×2，profile 配置为 `{limits: {web_search: 1, web_fetch: 0}, onExceeded: ask}`：

| 调用 | 结果 |
|---|---|
| `web_fetch`（配额 0） | 拒绝 |
| `web_search` 第 1 次 | 放行 |
| `web_search` 第 2 次（同 step） | 拒绝 |
| 新 step 的 `web_search` 第 1 次 | 放行 |
| 新 step 的 `web_search` 第 2 次 | 拒绝 |

一次跑通四条链路：配额生效、**同步预占**（同批并行调用只有一个通过）、**step 重置**（新 step 的第一次放行——若计数没重置，它会因上一 step 已用满而被拒，所以这一格同时验证了重置）、以及未配置的工具不受影响。

观察到的拒绝文案是 **`the user rejected tool "<name>"`**，而不是本插件自己的 `tool <name> exceeded its per-step limit of <n>`。这恰好是 `onExceeded` 生效的指纹：`deny` 会把插件写的 reason 原样传出，`ask` 则被 `dsh-tools` 替换成审批通道的文案。

**反直觉的坑：审批策略为 `never` 时 `ask` 不弹窗。** `dsh-user-approval` 的 `decide()` 先查策略，`never` 直接返回 `"rejected"`——**在派发给任何 answerer 之前**，所以界面根本收不到请求；而 `dsh-tools` 把 `rejected` 映射成 `the user rejected tool "…"`，于是"没人问过"和"人说了不"在这条路径上分不出来。策略由 permission preset 决定（本例 `danger-full-access` → `never`），且 preset 在会话初始化时会写入一条 session override，**优先级高于 `approval` 服务自己的 `config.policy`**（`effectivePolicy = overrideOf(session) ?? config.policy ?? "ask"`），所以单独给 `approval` 配 `policy: ask` 会被它盖住——要看到真正的弹窗只能切 preset。

### 审批弹窗的实测凭据（会话日志审计链）

`/permission danger-full-access` 重新应用后（把 preset 的 `approval` 从 `never` 改成 `ask`），`web_fetch` 两次调用都走通了完整审批。凭据来自会话日志本身：`~/.dsh/sessions/<cwd>/<session>/session.v4.jsonl.zstd` 是「头部帧 + 一个快照帧 + 数百个增量帧」，**每帧独立可解压**（`zstdDecompressSync` 与 `createZstdDecompress` 都只解第一帧，会得到 288 字节的假结果——必须按 magic `28 b5 2f fd` 逐帧解再拼接）。`dsh-user-approval` 每次请求都写 `approval/asked` + `approval/decided` 配对：

| seq | 事件 | 内容 |
|---|---|---|
| 3301 | `approval/policy` | `ask`（用户重新应用 preset） |
| 3314 → 3315 | `asked` → `decided` | `web_fetch`，`allowed-once` |
| 3331 → 3332 | `asked` → `decided` | `web_fetch`，`allowed-once` |

三点结论：**① 审批确实弹了**——`allowed-once` 只可能来自 answerer，没有 answerer 时会是 `unavailable`；**② `ask` 不预占名额的设计被证实**——两次调用是两个不同的请求 id、两次独立授权，没有出现"批准一次之后就不再问"；**③ 记在案的原因是本插件写的那句** `tool web_fetch exceeded its per-step limit of 0; requesting approval for one more call`，说明 `ask` 的 `reason` 原样透到了审批层（`displayReason` 供界面本地化）。

同一份日志也把 `never` 时期钉死了：seq 3152 / 3157 / 3167 / 3290 都是 `asked` → `decided: rejected`。**注意日志里的 "asked" 不等于"弹过窗"**——`request()` 先落 `approval/asked`，再由 `decide()` 查策略短路，所以 `never` 下同样有 asked 记录，但 answerer 瀑布从未被调用、界面什么都没显示（与"瞬间拒绝"的观察一致）。排查时不能拿 asked 记录当"确实弹过窗"的证据。

**另一条容易踩的：改 preset 定义不会回溯到已有会话。** 策略是记在会话日志里的持久事实（`overrideOf()` 从日志倒着找最后一条 `approval/policy`），而 `pinInitialPermission()` 只在 `approval === null` 时才补齐，所以已 seed 的会话不受影响——**重启也没用**，恢复会话时那条旧记录仍在。必须执行一次 `/permission <preset>` 重新应用；`apply()` 比的是**值**不是 preset 名字（`spec.approval !== knobs.approval`），所以重新选当前 preset 就够，不必先切走再切回。实测顺序正是如此：改文件后单独调 `web_fetch` 仍被瞬间拒绝（seq 3290），`/permission` 之后才放行（seq 3314）。

> **搜索范围必须是递归的。** `Get-ChildItem "$dsh\dsh-*\lib\*.js"` 只覆盖各包 `lib/` 的**顶层**（本次 453 个文件），而事件名等字符串有相当一部分落在 `lib/types/*.js` 里——用非递归形式搜会得到**全 0 的假红**，且文件数不为 0 也照样发生。可靠形式是 `Get-ChildItem $dsh -Recurse -Include *.js -File`。

## 运行时依赖（单基线：0.2.2-rc.5）

宿主提供的包走 `peerDependencies` 并全部标 `optional: true`（阻止 pnpm 引入第二份副本）：

| 包 | 版本 | 用途 |
|---|---|---|
| `@deepseek-ai/cordis` | `^4.1.0` | 插件框架（走自己的版本线） |
| `@deepseek-ai/dsh-agent` | `^0.2.2-rc.5` | `agent/pre-step` 等 Agent 事件 |
| `@deepseek-ai/dsh-tools` | `^0.2.2-rc.5` | `tools/pre-execute` 工具管线 |
| `@deepseek-ai/schemastery` | `~3.19.0` | 配置校验，**唯一真实的 `dependencies`** |

`devDependencies` 中的宿主包**钉死到基线精确版本**（`4.1.0` / `0.2.2-rc.5` / `0.2.2-rc.5`）：让 `tsc` 按基线宿主校验，连接点安装时插件解析到的是自己 `node_modules` 里的副本。安装出来的 `@deepseek-ai/dsh-*` 只有 0.2.2-rc.5 一条版本线（`dsh-agent` / `dsh-brand` / `dsh-error` / `dsh-llm` / `dsh-scope` / `dsh-session` / `dsh-session-projection` / `dsh-system-prompt` / `dsh-timeout` / `dsh-tools` / `dsh-typert-protocol` / `dsh-user-approval` / `dsh-util-crypto` / `dsh-util-values`），`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 按这份清单同步。

**`peerDependencies` 自 2026-11 起收成单臂 `^0.2.2-rc.5`**：`0.2.0-rc.2` 与 `0.2.1-rc.2` 两代宿主不再声明、也不再维护，历史支持窗口到此关闭。单臂不是"少写几行"，它把支持边界从"两代"收紧成"一条版本线"，于是**准入闸门从放行变成拦截**——实测 `satisfies('0.2.2-rc.1', '^0.2.2-rc.5', { includePrerelease: true }) === false`：宿主只要还没升到 rc.5，本插件就会被闸门**静默跳过**，不报错、不激活、只留一条 compatibility 警告，界面上的表现是"配额完全不生效"。所以**改窄 peer 与宿主确实运行在 rc.5 或更高，必须是同一步**；装好插件、确认宿主版本之后再重启。

`schemastery` 写 `~3.19.0`：宿主 0.2.2-rc.5 各包统一声明 `~3.19.0`，范围写宽会让本包解析到另一份实体，`Config` 的导出类型随即报 `TS2883`（无法命名）。实测对齐后 `pnpm why @deepseek-ai/schemastery` 只剩 3.19.0 一份，`typecheck` 退出 0。`cordis` 同理对齐宿主的 `~4.1.0` 线（宿主自身声明 `~4.1.0`，这里写 `^4.1.0`）。

**版本号 `0.2.2-rc.5.1` 是有意跨 tuple 的**（指南 §2.11）：号跟着宿主基线走，尾巴用保留点的 `rc.N.M` 形状。旧式收词写法 `rc2` 在预发布号到两位数时会字典序倒挂（`0.2.1-rc10.1 < 0.2.1-rc9.1`），而 `rc.9.1 < rc.10.1` 正确；跨 tuple 所以不会降级（`compare('0.2.2-rc.5.1', '0.2.0-rc2.2') = 1`）。改号只在用户明确提出时执行。

## DSH 0.2.2-rc.5 复核与端到端验证结论

复核环境是 `_rc5/`（`@deepseek-ai/dsh@0.2.2-rc.5`，独立 `DSH_HOME`，profile `call-limit`，`--port 0` 随机端口，全程不碰 3080）。**`_next-compat/` 已删除**——那是 `0.2.1-rc.2` 的旧环境，任何指向它的路径都已失效。

```powershell
# 复核（幂等，可反复跑）
node C:\Users\ParkGarden\DSH_Workspace\CreatePlugin\_rc5\probe\call-limit-e2e.mjs
```

**基线结果（2026-11-20）：`56 passed, 0 failed`**，连跑两次结果一致。

### 契约比对：五个扩展点全部未变

| 契约 | 0.2.2-rc.5 实测 |
|---|---|
| `agent/pre-step` | waterfall，载荷 `{ agent, messages, turn, step, signal, modelSelection }`；`next()` 出 `PreStepDecision` |
| `agent/disposed` | emit，`{ agent }` |
| `agent/turn-stopping` | serial，`{ agent, turn, signal }` |
| `agent/error` | emit，`{ agent, turn, step, error }` |
| `tools/pre-execute` | waterfall，`(exec: ToolExecution, next: () => Promise<PreToolDecision>)` |
| `ctx.tools` / `ctx.agents` | 服务名不变（`dsh-tools` 的 `super(ctx, "tools")`、`dsh-agent` 的 `super(ctx, "agents")`） |
| `PreToolDecision` | `allow` / `deny{reason, info?}` / `cancel` / `ask{reason?, displayReason?}` 四支齐全，**`onExceeded: "ask"` 依赖的 `displayReason` 未变** |
| `ToolExecution` | 仍是 `ToolExecutionInput` 的超集，`name` 与 `agent?` 都在 |
| `cordis` | 4.0.4 → 4.1.0；`EventOptions.prepend` 仍在，两个扩展点的 `{ prepend: true }` 继续有效 |
| `schemastery` | 3.18.4 → 3.19.0；`natural` / `transform` / `resolve` / `union` / `const` / `ValidationError` 全部仍在 |

唯一新增的是 `PreStepDecision` 的 `enter` 支多了可选的 `startsRequestSeries?: true`。本插件只把 `next()` 的决定原样返回、只读 `kind`，因此无需改动。

### 端到端：56 条断言覆盖了什么

1. **准入闸门与装载**：`evaluatePluginCompatibility()` 放行；`prepareProfile()` 的 `skippedBundles` 不含本包；本包确实是装配树里的一层。
2. **默认配置是惰性的**：`limits: {}` 时同一工具连调三次全部通过，且工具体真的执行了（返回了目录路径）。
3. **配额执行**：`limits: { working_directory: 1 }` 下第 1 次通过、第 2 次返回 `tool working_directory exceeded its per-step limit of 1` 且**工具体没有执行**；兄弟 Agent 有独立预算；新 step 重新获得名额。
4. **fail-closed 只对已配置工具生效**：无 Agent 上下文的已配置工具得到 `per-step tool limit requires an agent context`；同样形态的**未配置**工具则照常下到工具体（由工具自己报错），证明插件没有越界。
5. **四条清理路径（端到端）**：`agent/turn-stopping`、`agent/error`、`agent/disposed`、`pre-step` 返回 `reject`——清理后再调用都得到 `per-step tool limit has no active agent step`。第五条（`next()` 抛错）走的是异常分支，端到端里不好安全构造，由 `core.test.mjs` 的 `preStepThrows` 用例覆盖。
6. **并行不共用一个名额**：同一个 step 里三个并发调用，恰好一个通过、两个被拒。
7. **`onExceeded: "ask"`**：超额那一次只发出**一次** `approval.request`，`toolName` 正确、`reason` 带配额文案、`displayReason` 的 `en` / `zh` 都在；没有审批通道时由审批层（而非配额层）拒绝，两条拒绝文案可区分；通道批准一次后该次调用执行，且**下一次超额仍然要再问一次**（批准不提高配额）。
8. **坏配置**：负配额让 loader 拒绝该行——`1 entry did not activate` + `tool-call-limit (@zhourenke/dsh-tool-call-limit): ValidationError: invalid config: - $.working_directory expected number >= 0 but got -1`，插件不挂载、不装任何上限。**它不会静默变成一个不同的策略**，但也确实不会生效——这条只能靠宿主日志发现，所以配置改完要确认日志里没有 `did not activate`。
9. **分工与"没重复造轮子"**：见下节。

### 没有重复造轮子

`dsh-base` 的默认组合里**没有任何按 step 计数工具调用的包**（组合里 `tool-call` 只有 `@deepseek-ai/dsh-tool-call-timeout-policy`，它管的是单次调用的**超时**，不是次数）。

唯一容易看成重叠的是 `@deepseek-ai/dsh-tool-executor-ptc` 里的 `ToolCallLimitExceededError`：`run_code exceeded its limit of N tool calls (M per minute of its timeout); call K was not dispatched.` 但它**不是**同一个东西：

- 它由 `run_code` **自己那一次调用的 `timeoutMs` 推导**（`maxSubCalls = spec.timeoutMs === null ? Infinity : Math.floor(spec.timeoutMs / 6e4 * maxSubCallsPerMinute)`），配置面只有 `maxSubCallsPerMinute`（默认 1024）与 `maxParallelSubCalls`（默认 10），**没有按工具名、按 step 的任何开关**；
- 它数的是 `run_code` 程序内部**派发的嵌套调用**，目的是抓"程序里写了死循环"，失败表现是整段 `run_code` 以 `CODE_RUN_FAILED` 结束；
- 本插件数的是一次 step 里**进入 ToolRuntime 的调用**，按注册名分别计数，超额时**只拒那一次调用**（模型可以换工具继续），并能选择 `ask`。

两者层级、触发条件、失败语义都不同，是互补而非重复。同理 `maxParallelToolCalls` 管并发数、`dsh-spill-policy` 管结果留存、`dsh-repeat-tool-reminder` 管重复提醒，都不覆盖"每 step 每工具的次数上限"。

### 两条环境事实（踩过）

- **`ctx.tools.definitions()` 不带 scope 时只列全局层。** 在隔离 profile 里它只给出 `working_directory` 与 `team_task_*`，而其中只有 `working_directory` 能在 `tools.execute` 里真正解析出来（`team_task_*` 报 `unknown tool`，它们属于团队作用域）。**看不到某个能力不等于宿主没有它**，也不等于能直接执行它——探针因此以 `working_directory` 作承载体，它是 `dsh-tool-working-directory` 真正注册的全局工具，行为与任何被限流的工具等价（本插件按名字记账，与工具做什么无关）。
- **跨进程状态不存在，但会话是落盘的。** 每次 `runProfile` 都是新进程，配额状态本来就只在内存里；可 `agents.create({ sessionId })` 会把会话写进 `DSH_HOME/sessions`，同一个 id 第二次用会 `SessionAlreadyExistsError`。探针因此给每次运行加上时间戳后缀。

## 许可证

MIT
