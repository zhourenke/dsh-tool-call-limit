/**
 * @zhourenke/dsh-tool-call-limit
 *
 * Enforces per-Agent, per-turn, per-step limits on calls that enter the DSH
 * ToolRuntime. The state is process-local and keyed by the live Agent object.
 *
 * @module @zhourenke/dsh-tool-call-limit
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Resolved configuration accepted by {@link apply}. */
export interface ToolCallLimitConfig {
    limits: Record<string, number>;
    /** Enforcement for an exhausted quota; defaults to `'deny'`. */
    onExceeded?: 'deny' | 'ask';
}
export declare const Config: ReturnType<typeof z.any>;
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "tool-call-limit";
/**
 * Activation gate, not a service read. The plugin only ever subscribes to
 * events and never touches `ctx.tools` / `ctx.agents`, so a reference search
 * makes these two look removable; they are framework-consumed contract surface,
 * and cordis withholds `apply` until each injected name is ready. Keeping them
 * also keeps this fail-closed gate out of a host without an agent system, where
 * an agentless dispatch of a configured tool would be denied outright.
 */
export declare const inject: string[];
/**
 * Install the step tracker and the synchronous quota gate.
 *
 * The quota is reserved before the first await. JavaScript cannot interleave
 * another listener between the Map read and write, so parallel calls in one
 * step cannot both observe the same remaining slot.
 */
export declare function apply(ctx: Context, config: ToolCallLimitConfig): void;
