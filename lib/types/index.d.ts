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
}
export declare const Config: ReturnType<typeof z.any>;
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "tool-call-limit";
/** The limiter needs both the ToolRuntime and live Agent service. */
export declare const inject: string[];
/**
 * Install the step tracker and the synchronous quota gate.
 *
 * The quota is reserved before the first await. JavaScript cannot interleave
 * another listener between the Map read and write, so parallel calls in one
 * step cannot both observe the same remaining slot.
 */
export declare function apply(ctx: Context, config: ToolCallLimitConfig): void;
