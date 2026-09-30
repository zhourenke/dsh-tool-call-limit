# 开发注意事项（Development Notes）

面向维护者。使用者请看 [README.md](README.md)——那里只回答"能不能用、怎么调、哪里会踩坑"，实现内部细节一律放在本文档。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `src/index.ts` | 全部实现，单文件 |
| `lib/index.js` | 编译产物，**必须提交**（路线 A） |
| `lib/types/index.d.ts` | 类型声明，**必须提交** |
| `test/core.test.mjs` | 对编译产物的执行测试（15 项） |
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
- `*` 显式报错（`wildcard limits are not supported`），不做通配。

### 7. 配置校验选择"拒绝未知字段"

未知字段抛 `unknown configuration field(s): …` 而不是忽略。配置只有 `limits` 与 `onExceeded` 两个字段，静默忽略只会让拼错的字段名变成一条永不生效的规则——那比报错难查得多。

`resolveLimits()` 里还有一道 `Number.isSafeInteger(limit) && limit >= 0` 的复查，且**是抛错而不是跳过**：schema 已经校验过，但**直接以编程方式调用 `apply()`** 可以绕过 schema。跳过非法条目会让那个工具变成"不限"——插件看起来装了却在静默放行，与"限速器悄悄不工作"是同一类故障。抛错位置在注册任何监听器之前（`apply` 的第一行），所以被拒的配置不会留下半注册的插件。

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
- **`onExceeded` 两种取值**：`ask` 下超额返回 `kind: 'ask'` 且两种 locale 的 `displayReason` 都在；默认与显式 `deny` 都返回原来那条 deny；非法取值在注册前抛错

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

> **搜索范围必须是递归的。** `Get-ChildItem "$dsh\dsh-*\lib\*.js"` 只覆盖各包 `lib/` 的**顶层**（本次 453 个文件），而事件名等字符串有相当一部分落在 `lib/types/*.js` 里——用非递归形式搜会得到**全 0 的假红**，且文件数不为 0 也照样发生。可靠形式是 `Get-ChildItem $dsh -Recurse -Include *.js -File`。

## 运行时依赖（与 DSH 版本匹配）

宿主提供的包走 `peerDependencies` 并全部标 `optional: true`（阻止 pnpm 引入第二份副本）：

| 包 | 版本 | 用途 |
|---|---|---|
| `@deepseek-ai/cordis` | `^4.0.4` | 插件框架（走自己的版本线） |
| `@deepseek-ai/dsh-agent` | `^0.2.0-rc.2` | `agent/pre-step` 等 Agent 事件 |
| `@deepseek-ai/dsh-tools` | `^0.2.0-rc.2` | `tools/pre-execute` 工具管线 |
| `@deepseek-ai/schemastery` | `~3.18.4` | 配置校验，**唯一真实的 `dependencies`** |

`devDependencies` 中的三个宿主包**钉死到精确版本**（`4.0.4` / `0.2.0-rc.2` / `0.2.0-rc.2`）：连接点安装时插件解析到的是自己 `node_modules` 里的副本，写范围就会对着与线上不同的宿主做类型检查与测试。

`schemastery` 写 `~3.18.4` 而不是 `^3.18.2`：宿主各包统一声明 `~3.18.4`，范围写宽会让本包解析到另一份实体，`Config` 的导出类型随即报 `TS2883`（无法命名）。实测对齐后 `pnpm why @deepseek-ai/schemastery` 只剩一个版本，`typecheck` 与 `build` 都退出 0。

DSH 升级后按 `PLUGIN_RELEASE_GUIDE.md`「DSH 升级后的复核」重新核对事件名、宿主符号与 peer 范围。

## 许可证

MIT
