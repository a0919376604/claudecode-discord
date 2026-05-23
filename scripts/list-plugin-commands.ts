import { scanInstalledPlugins } from "../src/plugins/discovery.js";

const result = await scanInstalledPlugins();

console.log(`Discovered ${result.commands.length} command(s).`);
if (result.warnings.length > 0) {
  console.log(`\nWarnings:`);
  for (const w of result.warnings) console.log(`  - ${w}`);
}

if (result.commands.length === 0) {
  process.exit(0);
}

console.log(`\nCommands:`);
for (const c of result.commands) {
  console.log(`  /${c.commandName}  ←  ${c.pluginName}`);
  console.log(`    short name:   ${c.pluginShortName}`);
  console.log(`    install path: ${c.pluginInstallPath}`);
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
