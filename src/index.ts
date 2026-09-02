/**
 * @zhourenke/dsh-tool-call-limit
 *
 * Enforces per-Agent, per-turn, per-step limits on calls that enter the DSH
 * ToolRuntime. The state is process-local and keyed by the live Agent object.
 *
 * @module @zhourenke/dsh-tool-call-limit
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** The largest quota accepted by the configuration schema. */
const MAX_SAFE_LIMIT = Number.MAX_SAFE_INTEGER

/** A required, non-negative, integral quota for one named tool. */
const Limit = z.natural().max(MAX_SAFE_LIMIT).required()

/**
 * Return true only for ordinary records accepted as configuration maps.
 * Defined before schema construction because the custom schema resolver uses it.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Validate a plain object of tool limits without using a normal object as the
 * runtime lookup table. In particular, `__proto__`, `constructor`, and
 * `toString` remain ordinary tool names rather than prototype properties.
 */
const Limits = z.transform(
  z.any(),
  (value, options) => {
    if (!isPlainRecord(value)) {
      throw new z.ValidationError('expected an object of tool limits', options ?? {})
    }

    const result: Record<string, number> = {}
    for (const key of Object.keys(value)) {
      if (key === '*') {
        throw new z.ValidationError(
          'wildcard limits are not supported; configure each tool by name',
          options ?? {},
        )
      }
      const [limit] = z.resolve(value[key], Limit, {
        ...options,
        path: [...options?.path ?? [], key],
      })
      // defineProperty avoids the legacy Object.prototype.__proto__ setter.
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: limit as number,
        writable: true,
      })
    }
    return result
  },
  true,
).default({})

/** Resolved configuration accepted by {@link apply}. */
export interface ToolCallLimitConfig {
  limits: Record<string, number>
}

/** Plugin configuration schema. An absent or null limits map means no quotas. */
const configSchema = z.transform(
  z.any(),
  (value, options) => {
    if (!isPlainRecord(value)) {
      throw new z.ValidationError('expected an object configuration', options ?? {})
    }

    const unknownKeys = Object.keys(value).filter((key) => key !== 'limits')
    if (unknownKeys.length > 0) {
      throw new z.ValidationError(
        `unknown configuration field${unknownKeys.length === 1 ? '' : 's'}: ${unknownKeys.join(', ')}`,
        options ?? {},
      )
    }

    const [limits] = z.resolve(value.limits, Limits, {
      ...options,
      path: [...options?.path ?? [], 'limits'],
    })
    return {
      limits: limits as Record<string, number>,
    }
  },
  true,
).default({ limits: {} })

export const Config: ReturnType<typeof z.any> = configSchema

interface StepState {
  readonly turn: number
  readonly step: number
  readonly used: Map<string, number>
}

/** Copy validated limits into a prototype-safe Map for hot-path lookups. */
function resolveLimits(limits: Readonly<Record<string, number>>): ReadonlyMap<string, number> {
  const result = new Map<string, number>()
  for (const key of Object.keys(limits)) {
    const limit = limits[key]
    // Config has already validated these values. Keep this guard so a direct
    // programmatic call to apply() cannot introduce an invalid quota.
    if (Number.isSafeInteger(limit) && limit >= 0) {
      result.set(key, limit)
    }
  }
  return result
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-call-limit'

/** The limiter needs both the ToolRuntime and live Agent service. */
export const inject = ['tools', 'agents']

/**
 * Install the step tracker and the synchronous quota gate.
 *
 * The quota is reserved before the first await. JavaScript cannot interleave
 * another listener between the Map read and write, so parallel calls in one
 * step cannot both observe the same remaining slot.
 */
export function apply(ctx: Context, config: ToolCallLimitConfig): void {
  const limits = resolveLimits(config?.limits ?? {})
  // Keep state private to this plugin fiber. A reload therefore cannot reuse
  // reservations created by a previous configuration instance.
  const states = new WeakMap<Agent, StepState>()

  ctx.on('agent/pre-step', (payload, next) => {
    const state: StepState = {
      turn: payload.turn,
      step: payload.step,
      used: new Map(),
    }
    states.set(payload.agent, state)

    let pending: Promise<PreStepDecision>
    try {
      pending = next()
    } catch (error: unknown) {
      if (states.get(payload.agent) === state) states.delete(payload.agent)
      throw error
    }

    return pending.then((decision: PreStepDecision) => {
      // A rejected proposal never becomes an active step. Remove only the
      // state created by this invocation so a newer step cannot be erased.
      if (decision.kind === 'reject' && states.get(payload.agent) === state) {
        states.delete(payload.agent)
      }
      return decision
    }, (error: unknown) => {
      if (states.get(payload.agent) === state) states.delete(payload.agent)
      throw error
    })
  }, { prepend: true })

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent)
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const state = states.get(agent)
    if (state?.turn === turn) states.delete(agent)
  })

  ctx.on('agent/error', ({ agent, turn, step }) => {
    const state = states.get(agent)
    if (state?.turn === turn && state.step === step) states.delete(agent)
  })

  ctx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    const max = limits.get(exec.name)

    // An unconfigured tool is completely outside this plugin's policy. This
    // also preserves agentless/internal calls for tools with no configured cap.
    if (max === undefined) return next()

    const agent = exec.agent
    if (agent === undefined) {
      return Promise.resolve({
        kind: 'deny',
        reason: 'per-step tool limit requires an agent context',
      })
    }

    const state = states.get(agent)
    if (state === undefined) {
      return Promise.resolve({
        kind: 'deny',
        reason: 'per-step tool limit has no active agent step',
      })
    }

    const used = state.used.get(exec.name) ?? 0
    if (used >= max) {
      return Promise.resolve({
        kind: 'deny',
        reason: `tool ${exec.name} exceeded its per-step limit of ${max}`,
      })
    }

    // Do not move this reservation after `next()`: sibling calls may enter
    // this waterfall while the downstream policy is awaiting approval.
    state.used.set(exec.name, used + 1)
    return next()
  }, { prepend: true })
}
