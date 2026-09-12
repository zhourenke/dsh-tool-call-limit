[English](README.en.md) | **中文**

# @zhourenke/dsh-tool-call-limit

**给 DSH 的每个 step 加上工具调用配额：同一个 step 内超过配额的调用被直接拒绝。**

DSH 的 Agent 在一个 step 里可能并行发出多个工具调用，也可能在同一个工具上反复重试。本插件在工具真正执行之前按**注册名**检查配额：还有名额就放行，超了就拒绝——**只限流，不改工具本身的行为**。装好即用，无需改动 DSH 源码。

## 它解决什么问题

- **同一个 step 里反复调用同一个工具**：给 `web_search: 1` 之后，一个 step 内第二次调用会被拒绝，而不是让 Agent 继续消耗
- **想彻底禁用某个工具**：配 `0`，该 step 内所有调用都被拒绝
- **并行调用不会超额**：配额在调用前**同步预占**，两个并行的 `web_search` 只有一个能通过
- **父子 Agent 各自独立**：子 Agent 有自己的配额，不会吃掉父 Agent 的额度
- **随时可卸**：作为 profile 层插入，不修改 DSH 本体

## 安装

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-tool-call-limit"
```

**必须重启 DSH 才会生效**——插件由 loader 在进程启动时加载，刷新页面无效。

卸载：

```powershell
dsh plugin --profile web remove @zhourenke/dsh-tool-call-limit
```

## 快速上手

本插件默认**不限制任何工具**（`limits: {}`）。要启用限制，编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: tool-call-limit
      name: '@zhourenke/dsh-tool-call-limit'
      config:
        limits:
          web_search: 1
```

上面的配置表示：同一个 Agent 在同一个 step 里最多调用一次 `web_search`；下一个 step 重新获得配额，其他 Agent 有各自的配额。

**没有写进 `limits` 的工具完全不受限**——`web_fetch` 之所以不限，只是因为它没被列出来；需要时单独配它即可。

改完同样需要重启 DSH。确认配置已被加载：

```powershell
dsh --profile web --dump-config
```

在输出里能看到 `tool-call-limit` 与预期的 `limits` 即已生效。

> 仓库自带的 `cordis.patch.yml` 只负责把插件插入 bundle，**不含任何限制规则**。实际规则一律写在 profile patch 里，由 profile 决定启用哪些。

## 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|:---:|---|
| `limits` | object | `{}` | 工具注册名 → 该工具**每个 step** 允许的最大调用次数。未列出的工具不受限。 |

取值规则：

- `0` 表示在该 step 内拒绝该工具的**所有**调用；
- 正整数表示每个 step 允许的最大调用次数；
- 负数、小数、字符串、`NaN`、`Infinity`、超出 JavaScript 安全整数范围的数字、数组都会被拒绝；
- `limits: null`、省略 `limits`、省略整个 `config` 都按 `{}` 处理（即不限）；
- **不支持 `*` 通配符**，必须逐个工具名配置；
- 不认识的配置字段会被拒绝，不会静默忽略。

例如：

```yaml
limits:
  web_search: 1
  grep: 8
  write: 0
```

## 计数范围：Agent × turn × step × 工具名

配额按四个维度分别计算，任一维度不同就是一份**独立**的配额：

| 维度 | 说明 |
|---|---|
| Agent | 父 Agent 与 `subagent` 创建的子 Agent 是不同的 live Agent 对象，各自独立计数，**不会合并成一个总预算** |
| turn | 一个 turn 内的多个 step 各自计数 |
| step | **配额的重置单位**——进入新 step 时计数清零，重新获得全部名额 |
| 工具名 | 每个工具名单独计数，`web_search` 的调用**不占用** `web_fetch` 或 `grep` 的配额 |

## 配额怎么消耗

- **调用前同步预占**：名额在调用 `next()` **之前**就扣掉，所以同一个 step 里的并行调用不会同时看到同一个剩余名额。`web_search: 1` 时，两个并行的 `web_search` 只有一个能继续进入后续管线。
- **通过即消耗，不退还**：调用通过限制器后立刻消耗一个名额。之后即使工具失败、被取消、超时，或被后续的其他策略拒绝，也**不会退还**。
- **超限的调用不再消耗**：已经被拒绝的调用不会继续扣名额。

## 被拒绝时会看到什么

拒绝使用三条**稳定的英文**原因文本：

```text
tool <name> exceeded its per-step limit of <n>
per-step tool limit requires an agent context
per-step tool limit has no active agent step
```

第一条是配额用尽；后两条是缺少 Agent 上下文或该 Agent 没有有效的 step，此时采取 fail-closed（拒绝而非放行）。**读到第一条时不要重试同一个工具**——配额要到下一个 step 才会恢复。

## 给 Agent 的要点

- 本插件**没有提供任何工具、也没有模型可见的接口**，对模型完全透明：它约束的是**你本来就要调用的那些 DSH 工具**
- 被拒绝时表现为**工具调用失败**（返回上面三条原因之一），而不是静默变慢
- 同一个 step 内不要对同一个工具重复重试，配额不会在中途恢复
- 配置里用的必须是 DSH 的**注册名**，如 `web_search`、`web_fetch`、`grep`、`write`、`bash`、`run_code`

## 它管不到什么（限制边界）

本插件限制的是**进入 DSH `ToolRuntime` 的调用次数**，不是工具实现内部发生的操作次数。它不会限制：

- 一次 `web_search` 调用内部发出的多个 query；
- Web provider 内部的 HTTP 请求或原生 server-tool uses；
- 一次 `bash` 调用内部执行的多条 shell 命令；
- MCP 或其他自定义工具内部自行发起的多个 API 请求。

要限制单次 `web_search` 的 query 数量，需要另外配置 Web 工具的 `searchMaxQueries`；provider 提供 `maxUses` 时也要单独配置。它们与本插件的 ToolRuntime 调用配额属于**不同层级**。

`maxParallelToolCalls` 管的是**并发数量**，不是每 step 的总调用次数——本插件负责后者，两者互补。

## 已知限制（实测确认）

- **按进程独立计数**：状态保存在当前 DSH 进程内存中，不写入 session transcript，也不在进程重启或多个 DSH 实例之间共享。
- **父子 Agent 不合并预算**：需要在整体上限制父子 Agent 的合计调用数时，本插件不提供这个能力。
- **只限入口，不限内部**：见上一节的边界说明。
- **工具名写错不会报错**：配置里写一个不存在的工具名不会触发任何校验错误，只是那条规则永远不生效（因为没有任何调用会用它匹配）。工具名必须与 DSH 注册名逐字一致。

## 兼容性

在 **DSH v0.1.5-rc.1**（2026-09）下测试通过。

## 许可证

MIT
