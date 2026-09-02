[**English**](README.en.md) | [中文](README.md)

# @zhourenke/dsh-tool-call-limit

`@zhourenke/dsh-tool-call-limit` is a DeepSeek Harness Cordis plugin that limits calls entering the DSH `ToolRuntime`. Its policy is scoped by:

> one independent call quota for each live Agent, turn, step, and tool name.

The plugin does not need to import tools statically. Any call that passes through the DSH `ToolRuntime` can be limited by its registered name.

## Quick configuration

The plugin does not impose limits by default:

```yaml
limits: {}
```

Enable limits in the profile patch, for example:

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: tool-call-limit
  name: '@zhourenke/dsh-tool-call-limit'
  config:
    limits:
      web_search: 1
      # web_fetch is omitted, so this plugin does not limit it
```

This configuration allows at most one DSH `web_search` call for the same Agent in the same step. The next step starts with a fresh quota, and other Agents have separate quotas. `web_fetch` is not specially exempted; it remains unlimited because it is omitted from `limits`. It can be limited independently if needed.

The `cordis.patch.yml` in this repository only inserts the plugin into a bundle. It does not define tool limits. Put the effective rules in the target profile patch so the profile controls which limits are enabled.

## Installation and activation

Install the package through the DSH profile manager:

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-tool-call-limit"
```

Then add the plugin configuration to the target profile's `cordis.patch.yml`. To uninstall it:

```powershell
dsh plugin --profile web remove @zhourenke/dsh-tool-call-limit
```

Restart the existing DSH Web service after installing the plugin or changing the profile configuration so the new bundle and configuration are loaded. Then refresh the existing `http://127.0.0.1:3080`. This plugin does not start a replacement server and does not rely on client HMR.

## Configuration

The configuration has one field:

| Field | Default | Meaning |
|---|---:|---|
| `limits` | `{}` | A map from registered tool name to its maximum calls per step. Omitted tools are unlimited. |

For example:

```yaml
limits:
  web_search: 1
  grep: 8
  write: 0
```

Tool names must exactly match their DSH registration names. Values must be non-negative safe integers:

- `0` denies every call for that tool in an active step;
- a positive integer is the maximum number of calls allowed in each step;
- negative numbers, fractions, strings, `NaN`, infinity, numbers outside JavaScript's safe-integer range, and arrays are rejected;
- `limits: null`, an omitted `limits` field, and an omitted configuration are normalized as `{}`;
- `*` wildcards and a separate exemption syntax are not supported;
- unknown configuration fields are rejected.

## Counting semantics

The plugin records the Agent's current turn and step in `agent/pre-step`, creating a fresh counter map for each new step. `tools/pre-execute` then checks the tool name before the tool body runs.

When a call passes this plugin, its quota is reserved synchronously before `next()` is called. This prevents parallel calls in the same step from observing the same remaining slot. With `web_search: 1`, for example, only one of two parallel `web_search` calls can continue through the rest of the pipeline.

A call consumes its quota as soon as it passes the limiter. The reservation is not refunded if the tool later fails, is cancelled, times out, or is denied by a later policy. An attempt that is already over the limit does not consume another slot. Tool names have separate counters, so a `web_search` call does not consume the quota for `web_fetch` or `grep`.

A configured tool is denied fail-closed when its call has no Agent or when that Agent has no active state created by `agent/pre-step`. An unconfigured tool is unaffected by this context requirement and continues through the rest of the pipeline.

Denials use stable English reasons:

```text
tool <name> exceeded its per-step limit of <n>
per-step tool limit requires an agent context
per-step tool limit has no active agent step
```

## Agents, subagents, and Code Mode

A parent Agent and a child Agent created by `subagent` use different live Agent objects, so they have independent counter state by default. The plugin does not automatically combine parent and child Agents into one aggregate budget.

Tool calls made inside Code Mode count when they re-enter the DSH `ToolRuntime`, using the owning Agent's current step. The outer `run_code` call is limited only if `run_code` is also present in `limits`; otherwise it remains unlimited.

## Enforcement boundary

This plugin limits **the number of calls entering the DSH `ToolRuntime`**, not the number of operations performed inside a tool implementation. It does not directly limit:

- multiple queries issued internally by one `web_search` call;
- HTTP requests or native server-tool uses performed inside a Web provider;
- multiple shell commands executed inside one `bash` call;
- multiple API requests initiated internally by an MCP or other custom tool.

To limit the number of queries in one `web_search` call, configure the Web tool's `searchMaxQueries` separately. If a provider exposes `maxUses`, configure that separately as well. Those are lower-level controls and are distinct from this ToolRuntime call quota.

Likewise, `maxParallelToolCalls` limits concurrency, not the total number of calls in one step; this plugin provides the latter. The plugin keeps its state in the current DSH process memory. It does not write to the session transcript and does not share counters across process restarts or separate DSH instances.

## How it works

The plugin uses two public extension points:

1. `agent/pre-step` synchronizes the Agent's `(turn, step)` and resets that step's counter map;
2. `tools/pre-execute` returns allow or deny before the tool executes, based on `exec.name`.

Live Agent objects are keys in a `WeakMap`. State is cleared when a step is rejected or fails during preparation, when a turn stops, when the Agent reports an error, or when the Agent is disposed. Cordis also removes the event listeners automatically when the plugin fiber is unloaded.

## Development and verification

This project targets the current DSH `0.1.1-rc.2` API. After installing dependencies, run:

```powershell
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

`pnpm test` uses Node.js's built-in `node:test` and covers configuration validation, quota reset, Agent isolation, synchronous parallel reservation, downstream denial, missing context, lifecycle cleanup, and prototype-sensitive tool names. To inspect the composed profile configuration, run:

```powershell
dsh --profile web --dump-config
```

Confirm that the bundle contains `tool-call-limit` and that the final `limits` have the intended values before restarting the DSH Web service in use.

## License

MIT
