# 开发注意事项（Development Notes）

面向维护者。使用者请看 [README.md](README.md)——那里只回答"能不能用、怎么调、哪里会踩坑"，实现内部细节一律放在本文档。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `src/index.ts` | 全部实现，单文件 |
| `lib/index.js` | 编译产物，**必须提交**（路线 A） |
| `lib/types/index.d.ts` | 类型声明，**必须提交** |
| `test/core.test.mjs` | 对编译产物的执行测试（14 项） |
| `cordis.patch.yml` | profile 层插入声明 |

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

未知字段抛 `unknown configuration field(s): …` 而不是忽略。配置只有 `limits` 一个字段，静默忽略只会让拼错的字段名变成一条永不生效的规则——那比报错难查得多。

`resolveLimits()` 里保留了一道 `Number.isSafeInteger(limit) && limit >= 0` 的复查：schema 已经校验过，但**直接以编程方式调用 `apply()`** 可以绕过 schema，这道守卫保证那条路径也不会引入非法配额。

## 测试要点

- 直接 `import '../lib/index.js'`，断言模块契约（`name` / `inject` / `apply` / `Config`）
- 用模拟 ctx 调一次 `apply`：这是唯一能覆盖事件注册路径的办法
- **并行预占**：同一个 step 内两次 `tools/pre-execute`，断言只放行一个——这是第 1 条实现要点的回归测试
- **Agent 隔离**：两个不同 Agent 各自拿到完整配额
- **配额重置**：进入新 step 后计数清零
- **上下文缺失**：无 Agent、无 step 状态时的两条 fail-closed reason
- **生命周期清理**：`reject` / `turn-stopping` / `error` / `disposed` 后状态确实被移除
- **原型敏感工具名**：`__proto__`、`constructor`、`toString` 作为工具名能正常配置与计数

## 发布纪律

- **`lib/` 必须提交，且与 `src/` 同一次提交。** `dsh plugin add github:...` 只接收 git 跟踪的文件，本仓库不在安装时构建，所以产物不同步会让 GitHub 安装静默运行旧代码。
- **不要添加 `prepare` 脚本。** git 托管的包会在安装时执行它，而 pnpm 默认拦截依赖的构建脚本，这会让 `dsh plugin add` 直接失败，直到用户手动在 profile 的 `pnpm-workspace.yaml` 中放行。
- **`files` 只列不会被自动包含的产物。** 当前为 `lib/index.js`、`lib/types/**/*.d.ts`、`cordis.patch.yml`。`package.json` / `README*` / `LICEN[CS]E*` 以及 `main` 指向的文件无论如何都会装上，列了是空操作；而 `types` 与 `exports` 的目标**不在**自动包含集里，`.d.ts` 一旦漏出 `files` 就会被静默丢弃——插件照常加载，只是不带类型。
- 新增产物（第二入口、运行时读取的数据文件）时，必须同步放宽 `files`，并用 `pnpm pack --dry-run` 核对真实载荷。

## 运行时依赖（与 DSH 版本匹配）

宿主提供的包走 `peerDependencies` 并全部标 `optional: true`（阻止 pnpm 引入第二份副本）：

| 包 | 版本 | 用途 |
|---|---|---|
| `@deepseek-ai/cordis` | `^4.0.2` | 插件框架（走自己的版本线） |
| `@deepseek-ai/dsh-agent` | `^0.1.5-rc.1` | `agent/pre-step` 等 Agent 事件 |
| `@deepseek-ai/dsh-tools` | `^0.1.5-rc.1` | `tools/pre-execute` 工具管线 |
| `@deepseek-ai/schemastery` | `^3.18.2` | 配置校验，**唯一真实的 `dependencies`** |

`devDependencies` 中的三个宿主包**钉死到精确版本**（`4.0.2` / `0.1.5-rc.1` / `0.1.5-rc.1`）：连接点安装时插件解析到的是自己 `node_modules` 里的副本，写范围就会对着与线上不同的宿主做类型检查与测试。

DSH 升级后按 `PLUGIN_RELEASE_GUIDE.md` §8 重新核对事件名、宿主符号与 peer 范围。

## 许可证

MIT
