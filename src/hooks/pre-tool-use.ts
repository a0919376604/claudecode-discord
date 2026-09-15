import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { handleScheduleWakeup, type HookDeps, type HookResult } from "./schedule-wakeup.js";
import { handleCronCreate, handleCronList, handleCronDelete } from "./cron.js";
import { handlePushNotification } from "./push-notification.js";
import { handleBashLaunch } from "./bash-launch.js";

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
        case "CronCreate":
          return handleCronCreate(input.tool_input, deps);
        case "CronList":
          return handleCronList(input.tool_input, deps);
        case "CronDelete":
          return handleCronDelete(input.tool_input, deps);
        case "PushNotification":
          return handlePushNotification(input.tool_input, deps);
        case "Bash":
          // Observer-only: records codex slot → channel_id mappings so
          // wakeups can route back even when SKILL.md's Step 3/4 flow
          // isn't executed (manual retry, ad-hoc launches). ALWAYS
          // continues — never denies a Bash call. Any error is swallowed
          // by the outer try/catch below.
          return handleBashLaunch(input.tool_input, deps);
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
