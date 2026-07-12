import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { handleScheduleWakeup, type HookDeps, type HookResult } from "./schedule-wakeup.js";

export function createPreToolUseHook(deps: HookDeps) {
  return async (
    input: HookInput,
    _toolUseId: string | undefined,
    _options: { signal: AbortSignal },
  ): Promise<HookResult> => {
    if (input.hook_event_name !== "PreToolUse") {
      return { continue: true };
    }

    try {
      switch (input.tool_name) {
        case "ScheduleWakeup":
          return handleScheduleWakeup(input.tool_input, deps);
        default:
          return { continue: true };
      }
    } catch (e) {
      console.error(`[hook] PreToolUse ${input.tool_name} failed:`, e);
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Bot hook error: ${e instanceof Error ? e.message : String(e)}`,
        },
      };
    }
  };
}
