import type {
  DiscoveredCommand,
  RegisteredPluginCommand,
  SkippedPluginCommand,
} from "./types.js";

const DISCORD_GUILD_COMMAND_CAP = 100;

export interface RegisterResult {
  registered: RegisteredPluginCommand[];
  skipped: SkippedPluginCommand[];
}

/**
 * In-memory store of plugin commands that have won registration. Tracks
 * skipped commands for /plugins-list visibility.
 *
 * Constructed with the set of bot-owned slash command names so it can detect
 * collisions and skip the plugin command (bot-owned always wins).
 */
export class PluginRegistry {
  private store = new Map<string, RegisteredPluginCommand>();
  private skipped: SkippedPluginCommand[] = [];

  constructor(private readonly botOwnedNames: Set<string>) {}

  register(discovered: DiscoveredCommand[]): RegisterResult {
    // Reset skipped list on each register call so /plugins-sync reflects
    // only the latest scan.
    this.skipped = [];

    for (const cmd of discovered) {
      if (this.botOwnedNames.has(cmd.commandName)) {
        this.skipped.push({
          pluginName: cmd.pluginName,
          commandName: cmd.commandName,
          reason: "name-conflicts-with-bot-owned",
          sourcePath: cmd.sourcePath,
        });
        continue;
      }

      if (this.store.has(cmd.commandName)) {
        this.skipped.push({
          pluginName: cmd.pluginName,
          commandName: cmd.commandName,
          reason: "name-conflicts-with-prior-plugin",
          sourcePath: cmd.sourcePath,
        });
        continue;
      }

      const totalSlots = this.botOwnedNames.size + this.store.size;
      if (totalSlots >= DISCORD_GUILD_COMMAND_CAP) {
        this.skipped.push({
          pluginName: cmd.pluginName,
          commandName: cmd.commandName,
          reason: "exceeds-100-command-limit",
          sourcePath: cmd.sourcePath,
        });
        continue;
      }

      this.store.set(cmd.commandName, {
        ...cmd,
        registeredAt: Date.now(),
      });
    }

    return {
      registered: this.list(),
      skipped: [...this.skipped],
    };
  }

  lookup(commandName: string): RegisteredPluginCommand | undefined {
    return this.store.get(commandName);
  }

  list(): RegisteredPluginCommand[] {
    return Array.from(this.store.values());
  }

  skippedList(): SkippedPluginCommand[] {
    return [...this.skipped];
  }

  clear(): void {
    this.store.clear();
    this.skipped = [];
  }
}
