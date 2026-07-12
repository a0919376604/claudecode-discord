import type { HookDeps, HookResult } from "./schedule-wakeup.js";

function isPushInput(x: unknown): x is { message: string; priority?: string } {
  return typeof x === "object" && x !== null
    && typeof (x as { message?: unknown }).message === "string"
    && (x as { message: string }).message.length > 0;
}

function deny(reason: string): HookResult {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

export async function handlePushNotification(input: unknown, deps: HookDeps): Promise<HookResult> {
  if (!isPushInput(input)) {
    return deny("Invalid PushNotification input — expected {message: string}");
  }
  try {
    await deps.channel.send({ content: input.message });
    return deny("Notification sent");
  } catch (e) {
    return deny(`Failed to send notification: ${e instanceof Error ? e.message : String(e)}`);
  }
}
