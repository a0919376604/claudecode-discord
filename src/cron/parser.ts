import { CronExpressionParser } from "cron-parser";

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string };

export function validateCronExpr(expr: string): ValidationResult {
  if (expr.trim().length === 0) return { valid: false, error: "empty cron expression" };
  try {
    CronExpressionParser.parse(expr, { tz: "UTC" });
    return { valid: true };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function nextFireAfter(expr: string, fromMs: number): number {
  const interval = CronExpressionParser.parse(expr, { currentDate: new Date(fromMs), tz: "UTC" });
  return interval.next().getTime();
}
