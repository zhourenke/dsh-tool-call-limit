/**
 * @zhourenke/dsh-tool-call-limit
 *
 * Enforces per-Agent, per-turn, per-step limits on calls that enter the DSH
 * ToolRuntime. The state is process-local and keyed by the live Agent object.
 *
 * @module @zhourenke/dsh-tool-call-limit
 */
import z from '@deepseek-ai/schemastery';
/** The largest quota accepted by the configuration schema. */
const MAX_SAFE_LIMIT = Number.MAX_SAFE_INTEGER;
/** A required, non-negative, integral quota for one named tool. */
const Limit = z.natural().max(MAX_SAFE_LIMIT).required();
/**
 * Return true only for ordinary records accepted as configuration maps.
 * Defined before schema construction because the custom schema resolver uses it.
 */
function isPlainRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
/**
 * Validate a plain object of tool limits without using a normal object as the
 * runtime lookup table. In particular, `__proto__`, `constructor`, and
 * `toString` remain ordinary tool names rather than prototype properties.
 */
const Limits = z.transform(z.any(), (value, options) => {
    if (!isPlainRecord(value)) {
        throw new z.ValidationError('expected an object of tool limits', options ?? {});
    }
    const result = {};
    for (const key of Object.keys(value)) {
        if (key === '*') {
            throw new z.ValidationError('wildcard limits are not supported; configure each tool by name', options ?? {});
        }
        const [limit] = z.resolve(value[key], Limit, {
            ...options,
            path: [...options?.path ?? [], key],
        });
        // defineProperty avoids the legacy Object.prototype.__proto__ setter.
        Object.defineProperty(result, key, {
            configurable: true,
            enumerable: true,
            value: limit,
            writable: true,
        });
    }
    return result;
}, true).default({});
/**
 * What happens once a configured quota is used up.
 *
 * `deny` is the default and the original behaviour: the call never runs.
 * `ask` delegates to the composed approval service through DSH 0.2.0's
 * `{ kind: 'ask' }` pre-dispatch decision: the call runs only if the user
 * approves it once, and it still denies when no approval channel exists.
 */
const OnExceeded = z.union([z.const('deny'), z.const('ask')]).default('deny');
/** Plugin configuration schema. An absent or null limits map means no quotas. */
const configSchema = z.transform(z.any(), (value, options) => {
    if (!isPlainRecord(value)) {
        throw new z.ValidationError('expected an object configuration', options ?? {});
    }
    const unknownKeys = Object.keys(value).filter((key) => key !== 'limits' && key !== 'onExceeded');
    if (unknownKeys.length > 0) {
        throw new z.ValidationError(`unknown configuration field${unknownKeys.length === 1 ? '' : 's'}: ${unknownKeys.join(', ')}`, options ?? {});
    }
    const [limits] = z.resolve(value.limits, Limits, {
        ...options,
        path: [...options?.path ?? [], 'limits'],
    });
    const [onExceeded] = z.resolve(value.onExceeded, OnExceeded, {
        ...options,
        path: [...options?.path ?? [], 'onExceeded'],
    });
    return {
        limits: limits,
        onExceeded: onExceeded,
    };
}, true).default({ limits: {} });
export const Config = configSchema;
/**
 * Copy validated limits into a prototype-safe Map for hot-path lookups.
 *
 * The Config schema already rejects unusable numbers and shapes, but `apply()`
 * can also be called programmatically and bypass the schema. Validate both the
 * shape and each value, and reject rather than skip: a `Map` would read as
 * "no keys" (so every tool silently becomes unlimited) and an array would
 * install quotas for tools literally named "0" and "1". Silently doing nothing
 * is the same class of failure as a limiter that quietly never fires. Throwing
 * here runs before any listener is registered, so a bad configuration never
 * leaves a half-installed plugin behind.
 *
 * @see PLUGIN_RELEASE_GUIDE.md 「`Config` 的 schema 不保证数值可用」
 */
function resolveLimits(limits) {
    if (!isPlainRecord(limits)) {
        throw new Error('[tool-call-limit] limits must be a plain object mapping tool names to quotas');
    }
    const result = new Map();
    for (const key of Object.keys(limits)) {
        const limit = limits[key];
        if (!Number.isSafeInteger(limit) || limit < 0) {
            throw new Error(`[tool-call-limit] limit for "${key}" must be a non-negative safe integer, got ${String(limit)}`);
        }
        result.set(key, limit);
    }
    return result;
}
/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-call-limit';
/** The limiter needs both the ToolRuntime and live Agent service. */
export const inject = ['tools', 'agents'];
/**
 * Install the step tracker and the synchronous quota gate.
 *
 * The quota is reserved before the first await. JavaScript cannot interleave
 * another listener between the Map read and write, so parallel calls in one
 * step cannot both observe the same remaining slot.
 */
export function apply(ctx, config) {
    const limits = resolveLimits(config?.limits ?? {});
    // Same fail-loud discipline as the limits map: a programmatic caller can
    // bypass the schema, and an unrecognised value here would silently pick a
    // different enforcement than the caller asked for. Checked before any
    // listener is registered.
    const onExceeded = config?.onExceeded ?? 'deny';
    if (onExceeded !== 'deny' && onExceeded !== 'ask') {
        throw new Error(`[tool-call-limit] onExceeded must be "deny" or "ask", got ${String(onExceeded)}`);
    }
    // Keep state private to this plugin fiber. A reload therefore cannot reuse
    // reservations created by a previous configuration instance.
    const states = new WeakMap();
    ctx.on('agent/pre-step', (payload, next) => {
        const state = {
            turn: payload.turn,
            step: payload.step,
            used: new Map(),
        };
        states.set(payload.agent, state);
        let pending;
        try {
            pending = next();
        }
        catch (error) {
            if (states.get(payload.agent) === state)
                states.delete(payload.agent);
            throw error;
        }
        return pending.then((decision) => {
            // A rejected proposal never becomes an active step. Remove only the
            // state created by this invocation so a newer step cannot be erased.
            if (decision.kind === 'reject' && states.get(payload.agent) === state) {
                states.delete(payload.agent);
            }
            return decision;
        }, (error) => {
            if (states.get(payload.agent) === state)
                states.delete(payload.agent);
            throw error;
        });
    }, { prepend: true });
    ctx.on('agent/disposed', ({ agent }) => {
        states.delete(agent);
    });
    ctx.on('agent/turn-stopping', ({ agent, turn }) => {
        const state = states.get(agent);
        if (state?.turn === turn)
            states.delete(agent);
    });
    ctx.on('agent/error', ({ agent, turn, step }) => {
        const state = states.get(agent);
        if (state?.turn === turn && state.step === step)
            states.delete(agent);
    });
    ctx.on('tools/pre-execute', (exec, next) => {
        const max = limits.get(exec.name);
        // An unconfigured tool is completely outside this plugin's policy. This
        // also preserves agentless/internal calls for tools with no configured cap.
        if (max === undefined)
            return next();
        const agent = exec.agent;
        if (agent === undefined) {
            return Promise.resolve({
                kind: 'deny',
                reason: 'per-step tool limit requires an agent context',
            });
        }
        const state = states.get(agent);
        if (state === undefined) {
            return Promise.resolve({
                kind: 'deny',
                reason: 'per-step tool limit has no active agent step',
            });
        }
        const used = state.used.get(exec.name) ?? 0;
        if (used >= max) {
            const reason = `tool ${exec.name} exceeded its per-step limit of ${max}`;
            if (onExceeded === 'ask') {
                // Deliberately does not reserve a slot: the approval outcome is decided
                // after this listener returns, so the counter keeps counting
                // auto-allowed calls only. Every call past the quota is therefore
                // authorised individually, which is the entire point of `ask`.
                return Promise.resolve({
                    kind: 'ask',
                    reason: `${reason}; requesting approval for one more call`,
                    displayReason: {
                        en: `Allow one more call to ${exec.name} this step? (per-step limit: ${max})`,
                        zh: `允许本 step 再调用一次 ${exec.name}？（每 step 上限 ${max}）`,
                    },
                });
            }
            return Promise.resolve({ kind: 'deny', reason });
        }
        // Do not move this reservation after `next()`: sibling calls may enter
        // this waterfall while the downstream policy is awaiting approval.
        state.used.set(exec.name, used + 1);
        return next();
    }, { prepend: true });
}
