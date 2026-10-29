import { L } from "../utils/i18n.js";

/** A bounded activity summary, shared by Claude and Codex progress displays. */
export function formatToolActivity(toolName: string, input: Record<string, unknown>, ok?: boolean): string {
  const labels: Record<string, string> = {
    Read: L("Reading files", "파일 읽는 중"),
    Glob: L("Searching files", "파일 검색 중"),
    Grep: L("Searching code", "코드 검색 중"),
    Write: L("Writing file", "파일 작성 중"),
    Edit: L("Editing file", "파일 편집 중"),
    Bash: L("Running command", "명령어 실행 중"),
    WebSearch: L("Searching web", "웹 검색 중"),
    WebFetch: L("Fetching URL", "URL 가져오는 중"),
    TodoWrite: L("Updating tasks", "작업 업데이트 중"),
    MCP: L("Using MCP", "MCP 사용 중"),
    ImageGeneration: L("Generating image", "이미지 생성 중"),
    Agent: L("Using agent", "에이전트 사용 중"),
  };
  const basename = (value: string) => value.split(/[\\/]/).pop() ?? value;
  let detail = "";
  if (typeof input.file_path === "string") detail = basename(input.file_path);
  else if (Array.isArray(input.changes)) {
    detail = input.changes.flatMap((change) =>
      change && typeof change.path === "string" ? [basename(change.path)] : [],
    ).join(", ");
  } else if (typeof input.tool === "string") {
    detail = typeof input.server === "string" ? `${input.server}/${input.tool}` : input.tool;
  } else if (typeof input.command === "string") detail = input.command;
  else if (typeof input.query === "string") detail = input.query;
  else if (typeof input.url === "string") detail = input.url;
  else if (input.action && typeof input.action === "object") {
    const action = input.action as Record<string, unknown>;
    if (typeof action.query === "string") detail = action.query;
    else if (typeof action.url === "string") detail = action.url;
  }

  // Codex annotates shell reads/searches with structured command actions.
  // Prefer those annotations to guessing from arbitrary shell syntax.
  if (toolName === "Bash" && Array.isArray(input.commandActions) && input.commandActions.length === 1) {
    const action = input.commandActions[0];
    if (action && action.type === "read" && typeof action.path === "string") {
      toolName = "Read";
      detail = basename(action.path);
    } else if (action && action.type === "search") {
      toolName = "Grep";
      if (typeof action.query === "string") detail = action.query;
    } else if (action && action.type === "listFiles") {
      toolName = "Glob";
      if (typeof action.path === "string") detail = action.path;
    }
  }

  detail = detail.replace(/[`\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  if (detail.length > 120) detail = `${detail.slice(0, 117)}...`;
  const label = ok === undefined ? labels[toolName] ?? `Using ${toolName}` : `${ok ? "✅" : "❌"} ${toolName}`;
  return `${label}${detail ? ` \`${detail}\`` : ""}`;
}
