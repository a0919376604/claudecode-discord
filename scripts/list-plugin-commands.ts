// Dev inspection script — scans plugin + user + project command sources and
// prints what the bot would register as Discord slash commands. Run with:
//   npm run scripts:list-plugin-commands [optional-project-path] [more-paths...]
// If no project paths are passed, project-scope is skipped (use ".", "$(pwd)"
// or a registered project root to see project-scope commands too).

import { scanAllCommandSources } from "../src/plugins/discovery.js";

const projectPaths = process.argv.slice(2);
const result = await scanAllCommandSources({ projectPaths });

console.log(`Discovered ${result.commands.length} command(s).`);
if (projectPaths.length > 0) {
  console.log(`Scanned project paths:`);
  for (const p of projectPaths) console.log(`  - ${p}`);
}

if (result.warnings.length > 0) {
  console.log(`\nWarnings:`);
  for (const w of result.warnings) console.log(`  - ${w}`);
}

if (result.commands.length === 0) {
  process.exit(0);
}

console.log(`\nCommands:`);
for (const c of result.commands) {
  const source =
    c.scope === "plugin"
      ? c.pluginName
      : c.scope === "user"
        ? "~/.claude/commands"
        : c.projectPath ?? "<project>";
  console.log(`  [${c.scope}] /${c.commandName}  ←  ${source}`);
  if (c.scope === "plugin") {
    console.log(`    short name:   ${c.pluginShortName}`);
    console.log(`    install path: ${c.pluginInstallPath}`);
  }
  console.log(`    description:  ${c.description}`);
  if (c.parsedParams.length === 0) {
    console.log(`    params: (none — fallback to single 'args')`);
  } else {
    for (const p of c.parsedParams) {
      const marker = p.required ? "<required>" : "[optional]";
      console.log(`    param: ${p.name} ${marker}  — ${p.description}`);
    }
  }
}
