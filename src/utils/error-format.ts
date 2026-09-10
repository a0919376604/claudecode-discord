/**
 * Extract a human-readable message from an error, unwrapping aggregate
 * error shapes so shapeshift's opaque "Received one or more errors" and
 * AggregateError instances surface their inner details.
 *
 * Why: discord.js (via @sapphire/shapeshift) wraps multi-validator failures
 * into a `CombinedError` whose `.message` is always the string "Received one
 * or more errors", with the actual failing validators hidden in `.errors[]`.
 * Node's built-in `AggregateError` has the same structure (`.errors` array).
 * A plain `console.error(e.message)` hides the useful information — we need
 * to walk `.errors` to see WHAT actually failed.
 *
 * This unwrap is bounded (depth 3, max 8 sub-errors) so a pathological
 * nested error can't produce megabyte log lines.
 */
export function unwrapErrorMessage(error: unknown, depth = 0): string {
  if (depth > 3) return "…";
  if (!error) return "Unknown error";

  // Look for the .errors[] array shape (CombinedError, AggregateError, or
  // anything ducktyping the same).
  if (typeof error === "object" && "errors" in (error as Record<string, unknown>)) {
    const inner = (error as { errors: unknown }).errors;
    if (Array.isArray(inner) && inner.length > 0) {
      const label =
        (error as { message?: unknown }).message !== undefined &&
        typeof (error as { message?: unknown }).message === "string"
          ? String((error as { message: string }).message)
          : (error as { constructor?: { name?: string } }).constructor?.name ?? "AggregateError";
      const parts = inner
        .slice(0, 8)
        .map((e) => unwrapErrorMessage(e, depth + 1));
      const suffix = inner.length > 8 ? ` (+${inner.length - 8} more)` : "";
      return `${label}: [${parts.join(" | ")}]${suffix}`;
    }
  }

  if (error instanceof Error) {
    return error.message || error.constructor.name;
  }

  return String(error);
}
