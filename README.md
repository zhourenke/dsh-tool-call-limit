[English](README.en.md) | **中文**

# @zhourenke/dsh-tool-call-limit

`@zhourenke/dsh-tool-call-limit` 是一个 DeepSeek Harness Cordis 插件，用于限制进入 DSH `ToolRuntime` 的工具调用次数。限制范围是：

> 每个 live Agent、每个 turn、每个 step、每个工具名，分别使用独立的调用配额。

插件不需要静态导入工具。只要调用经过 DSH `ToolRuntime`，就可以按它的注册名配置限制。

## 快速配置

插件默认不限制任何工具：

```yaml
limits: {}
```

在 profile 的 patch 中启用限制，例如：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: tool-call-limit
  name: '@zhourenke/dsh-tool-call-limit'
  config:
    limits:
      web_search: 1
      # web_fetch 未列出，因此不受本插件限制
```

上面的配置表示：同一个 Agent 在同一个 step 中最多调用一次 DSH `web_search`。下一个 step 会重新获得一次配额；其他 Agent 也有自己的配额。`web_fetch` 没有被特殊处理，只是因为没有写入 `limits` 才保持不限；如果需要，也可以单独配置它。

本仓库中的 `cordis.patch.yml` 只负责把插件插入 bundle，不提供工具限制。实际限制应在 profile patch 中配置，以便由当前 profile 决定启用哪些规则。

## 安装与启用

使用 DSH profile 管理命令安装：

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-tool-call-limit"
```

安装后，在目标 profile 的 `cordis.patch.yml` 中加入插件配置。卸载时执行：

```powershell
dsh plugin --profile web remove @zhourenke/dsh-tool-call-limit
```

安装插件或修改 profile 配置后，需要重启现有的 DSH Web 服务，新的 bundle 和配置才会生效；随后刷新原有的 `http://127.0.0.1:3080` 即可。插件本身不会启动替代服务器，也不依赖客户端 HMR。

## 配置格式

配置只有一个字段：

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `limits` | `{}` | 工具注册名到该工具每 step 最大调用次数的映射。未列出的工具不限。 |

例如：

```yaml
limits:
  web_search: 1
  grep: 8
  write: 0
```

工具名必须与 DSH 注册名完全一致，值必须是非负安全整数：

- `0` 表示在 active step 中拒绝该工具的所有调用；
- 正整数表示每个 step 允许的最大调用次数；
- 负数、浮点数、字符串、`NaN`、无穷大、超出 JavaScript 安全整数范围的数字和数组都会被拒绝；
- `limits: null`、省略 `limits` 或省略整个配置会按 `{}` 处理；
- 不支持 `*` 通配符，也不支持单独的“豁免”语法；
- 不认识的配置字段会被拒绝。

## 调用计数语义

插件在 `agent/pre-step` 中记录 Agent 当前的 turn 和 step，并为新 step 建立新的计数表。随后，`tools/pre-execute` 会在工具 body 执行之前按工具名检查配额。

调用通过本插件时，配额会在调用 `next()` 之前同步预占。这一点保证了同一个 step 中的并行调用不会同时看到同一个剩余名额。例如 `web_search: 1` 时，两个并行的 `web_search` 调用只有一个可以继续进入后续管线。

已通过限制器的调用立即消耗一个名额。之后即使工具失败、被取消、超时，或被后续的其他策略拒绝，也不会退还该名额；已经超限的调用不会再次消耗名额。不同工具名分别计数，因此一次 `web_search` 不会占用 `web_fetch` 或 `grep` 的配额。

当工具配置了限制但调用缺少 Agent，或该 Agent 没有经过有效的 `agent/pre-step` 时，插件采用 fail-closed 策略并拒绝调用。未配置限制的工具不会受此上下文要求影响，仍会直接进入后续管线。

拒绝原因使用稳定的英文文本：

```text
tool <name> exceeded its per-step limit of <n>
per-step tool limit requires an agent context
per-step tool limit has no active agent step
```

## Agent、子 Agent 与 Code Mode

父 Agent 与 `subagent` 创建的子 Agent 使用不同的 live Agent 对象，因此默认拥有相互独立的计数状态；插件不会自动把父子 Agent 合并为一个总预算。

Code Mode 中重新进入 DSH `ToolRuntime` 的内部工具调用，会按所属 Agent 的当前 step 计数。外层 `run_code` 是否受限，则取决于是否另外配置了 `run_code`：配置了就计数，没有配置就不限。

## 限制边界

本插件限制的是**进入 DSH `ToolRuntime` 的调用次数**，不是工具实现内部发生的操作次数。它不会直接限制：

- 一次 `web_search` 调用内部发出的多个 query；
- Web provider 内部的 HTTP 请求或原生 server-tool uses；
- 一次 `bash` 调用内部执行的多条 shell 命令；
- MCP 或其他自定义工具内部自行发起的多个 API 请求。

如果需要限制单次 `web_search` 的 query 数量，还要配置 Web 工具的 `searchMaxQueries`；如果 provider 提供 `maxUses`，也需要单独配置。它们与本插件的 ToolRuntime 调用配额属于不同层级。

此外，`maxParallelToolCalls` 是并发数量上限，不是每 step 的总调用次数上限；本插件负责后者。插件状态保存在当前 DSH 进程内存中，不写入 session transcript，也不在进程重启或多个 DSH 实例之间共享。

## 工作原理

插件使用两个公开扩展点：

1. `agent/pre-step`：同步当前 Agent 的 `(turn, step)`，并重置该 step 的计数表；
2. `tools/pre-execute`：在工具执行前根据 `exec.name` 返回 allow 或 deny。

计数状态以 live Agent 对象为 key 保存在 `WeakMap` 中。step 被拒绝、step 准备失败、turn 结束、Agent 报错或 Agent 被 dispose 时，相关状态会被清理；Cordis 也会在插件 fiber 卸载时自动移除事件监听器。

## 开发与验证

本项目针对当前 DSH `0.1.1-rc.2` API 开发。安装依赖后可以运行：

```powershell
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

`pnpm test` 使用 Node.js 内置的 `node:test`，覆盖配置校验、配额重置、Agent 隔离、并行预占、下游拒绝、上下文缺失、生命周期清理以及原型敏感工具名等行为。检查 profile 组合配置时可以运行：

```powershell
dsh --profile web --dump-config
```

确认 bundle 中存在 `tool-call-limit`，并确认最终的 `limits` 是预期值后，再重启正在使用的 DSH Web 服务。

## License

MIT
