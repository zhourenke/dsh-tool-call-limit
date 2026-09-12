**English** | [中文](README.md)

# @zhourenke/dsh-tool-call-limit

**Per-step tool call quotas for DSH: calls beyond the quota in the same step are denied outright.**

A DSH Agent may issue several tool calls in parallel within one step, and may retry the same tool repeatedly. This plugin checks a quota by **registered name** before the tool actually runs: if a slot is left it passes through, if not it denies — **it only throttles, it never changes what a tool does**. Install and go; no DSH source changes needed.

## What it solves

- **Repeated calls to the same tool within one step**: with `web_search: 1`, a second call in the same step is denied instead of letting the Agent keep spending
- **Disabling a tool entirely**: set `0` and every call to it is denied in that step
- **Parallel calls cannot overshoot**: the quota is reserved **synchronously** before the call, so of two parallel `web_search` calls only one gets through
- **Parent and child Agents stay separate**: a subagent has its own quota and does not eat the parent's allowance
- **Removable at any time**: inserted at the profile layer, it does not modify DSH itself

## Installation

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-tool-call-limit"
```

**A DSH restart is required for it to take effect** — the plugin is loaded by the loader at process start, so refreshing the page does nothing.

Uninstall:

```powershell
dsh plugin --profile web remove @zhourenke/dsh-tool-call-limit
```

## Quick start

By default the plugin limits **nothing** (`limits: {}`). To enable limits, edit `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: tool-call-limit
      name: '@zhourenke/dsh-tool-call-limit'
      config:
        limits:
          web_search: 1
```

This allows the same Agent at most one `web_search` call per step; the next step gets a fresh quota, and other Agents have their own.

**Any tool not listed in `limits` is completely unlimited** — `web_fetch` is unlimited only because it is omitted; configure it separately if you want it capped.

A restart is needed here too. To confirm the configuration was loaded:

```powershell
dsh --profile web --dump-config
```

If the output contains `tool-call-limit` with the expected `limits`, it is in effect.

> The `cordis.patch.yml` shipped in this repository only inserts the plugin into a bundle. It defines **no** limit rules. Real rules always live in the profile patch, so the profile decides which are enabled.

## Configuration

| Field | Type | Default | Meaning |
|---|---|:---:|---|
| `limits` | object | `{}` | Map from registered tool name to the maximum calls allowed **per step**. Omitted tools are unlimited. |

Value rules:

- `0` denies **every** call to that tool in the step;
- a positive integer is the maximum number of calls allowed per step;
- negative numbers, fractions, strings, `NaN`, `Infinity`, numbers outside JavaScript's safe-integer range, and arrays are all rejected;
- `limits: null`, an omitted `limits` field, and an omitted `config` are all treated as `{}` (unlimited);
- **`*` wildcards are not supported**; every tool must be configured by name;
- unknown configuration fields are rejected rather than silently ignored.

For example:

```yaml
limits:
  web_search: 1
  grep: 8
  write: 0
```

## Scope: Agent × turn × step × tool name

Quotas are counted along four dimensions; a difference in any one of them means a **separate** quota:

| Dimension | Meaning |
|---|---|
| Agent | A parent Agent and a child Agent created by `subagent` are different live Agent objects with independent counters; they are **not merged into one aggregate budget** |
| turn | Each step within a turn counts separately |
| step | **The reset unit** — entering a new step clears the counters and restores the full allowance |
| tool name | Each tool name is counted separately, so a `web_search` call does **not** consume the quota for `web_fetch` or `grep` |

## How quota is consumed

- **Reserved synchronously before the call**: the slot is taken **before** `next()` is invoked, so parallel calls in the same step cannot observe the same remaining slot. With `web_search: 1`, only one of two parallel `web_search` calls continues through the rest of the pipeline.
- **Passing consumes it, with no refund**: a call consumes a slot as soon as it passes the limiter. It is **not** refunded if the tool later fails, is cancelled, times out, or is denied by a later policy.
- **Denied calls consume nothing further**: a call that is already over the limit does not take another slot.

## What you see when a call is denied

Denials use three **stable English** reason texts:

```text
tool <name> exceeded its per-step limit of <n>
per-step tool limit requires an agent context
per-step tool limit has no active agent step
```

The first means the quota is exhausted; the last two mean the Agent context is missing or the Agent has no active step, in which case the plugin fails closed (denies rather than allows). **On the first one, do not retry the same tool** — the quota only returns in the next step.

## Key points for Agents

- This plugin **provides no tools and no model-visible interface**; it is fully transparent to the model and constrains **the DSH tools you were already going to call**
- A denial shows up as a **failed tool call** (returning one of the three reasons above), not as a silent slowdown
- Do not retry the same tool within the same step; the quota does not recover mid-step
- Names in the configuration must be DSH **registration names**, such as `web_search`, `web_fetch`, `grep`, `write`, `bash`, `run_code`

## What it does not cover (enforcement boundary)

This plugin limits **the number of calls entering the DSH `ToolRuntime`**, not the number of operations performed inside a tool implementation. It does not limit:

- multiple queries issued inside one `web_search` call;
- HTTP requests or native server-tool uses performed inside a Web provider;
- multiple shell commands executed inside one `bash` call;
- multiple API requests initiated by an MCP or other custom tool.

To cap the number of queries in one `web_search` call, configure the Web tool's `searchMaxQueries` separately, and configure `maxUses` separately where a provider exposes it. Those are at a **different layer** from this plugin's ToolRuntime call quota.

`maxParallelToolCalls` limits **concurrency**, not the total number of calls per step — this plugin provides the latter, and the two are complementary.

## Known limitations (verified)

- **Counted per process**: state lives in the current DSH process memory. It is not written to the session transcript and is not shared across process restarts or separate DSH instances.
- **Parent and child budgets are not merged**: the plugin cannot cap the combined call count of a parent Agent and its subagents.
- **Entry point only, not internals**: see the boundary section above.
- **A misspelled tool name raises no error**: an unknown name in the configuration triggers no validation error; the rule simply never applies, because no call will ever match it. Tool names must match DSH registration names exactly.

## Compatibility

Tested with **DSH v0.1.5-rc.1** (September 2026).

## License

MIT
