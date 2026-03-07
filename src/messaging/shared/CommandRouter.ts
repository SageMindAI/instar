/**
 * Platform-agnostic command router.
 *
 * Extracted from TelegramAdapter as part of Phase 1 shared infrastructure.
 * Parses slash commands from incoming messages and routes them to
 * registered handlers. Platform adapters register their own command
 * handlers at startup.
 */

export interface CommandContext {
  /** The full original text (before parsing) */
  rawText: string;
  /** The command name without slash, lowercased (e.g., 'status') */
  command: string;
  /** Arguments after the command (trimmed), empty string if none */
  args: string;
  /** Channel/topic ID where the command was received */
  channelId: string;
  /** User ID who sent the command */
  userId: string;
  /** Platform-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * A command handler returns true if the command was handled,
 * false to pass to the next handler or fall through to normal message routing.
 */
export type CommandHandler = (ctx: CommandContext) => Promise<boolean>;

interface RegisteredCommand {
  /** Command name(s) — first is primary, rest are aliases */
  names: string[];
  /** Handler function */
  handler: CommandHandler;
  /** Whether this command requires exact match (vs prefix match) */
  exact: boolean;
  /** Human-readable description for /help */
  description?: string;
  /** Platform restrictions — if set, only runs on these platforms */
  platforms?: string[];
}

export class CommandRouter {
  private commands: RegisteredCommand[] = [];
  private platform: string;

  /** Interceptors run before command routing (e.g., attention topic commands) */
  private interceptors: Array<(ctx: CommandContext) => Promise<boolean>> = [];

  constructor(platform: string) {
    this.platform = platform;
  }

  /**
   * Register a command handler.
   *
   * @param names - Command name(s). First is primary, rest are aliases.
   *   e.g., ['status'] matches '/status'
   *   e.g., ['switch-account', 'sa'] matches '/switch-account' and '/sa'
   * @param handler - Async function that handles the command
   * @param options - Additional options
   */
  register(
    names: string | string[],
    handler: CommandHandler,
    options?: {
      exact?: boolean;
      description?: string;
      platforms?: string[];
    },
  ): void {
    const nameList = Array.isArray(names) ? names : [names];
    this.commands.push({
      names: nameList.map(n => n.toLowerCase().replace(/^\//, '')),
      handler,
      exact: options?.exact ?? true,
      description: options?.description,
      platforms: options?.platforms,
    });
  }

  /**
   * Add an interceptor that runs before command routing.
   * Interceptors receive the parsed context and return true to short-circuit.
   * Use for context-dependent routing (e.g., attention topic commands).
   */
  addInterceptor(interceptor: (ctx: CommandContext) => Promise<boolean>): void {
    this.interceptors.push(interceptor);
  }

  /**
   * Parse and route a command. Returns true if handled.
   *
   * @param text - The raw message text
   * @param channelId - Channel/topic where the message was received
   * @param userId - User who sent the message
   * @param metadata - Optional platform-specific metadata
   */
  async route(
    text: string,
    channelId: string,
    userId: string,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    if (!text.startsWith('/')) return false;

    const parsed = this.parse(text);
    if (!parsed) return false;

    const ctx: CommandContext = {
      rawText: text,
      command: parsed.command,
      args: parsed.args,
      channelId,
      userId,
      metadata,
    };

    // Run interceptors first
    for (const interceptor of this.interceptors) {
      try {
        if (await interceptor(ctx)) return true;
      } catch (err) {
        console.error(`[command-router] Interceptor error: ${err}`);
      }
    }

    // Find matching command
    for (const cmd of this.commands) {
      // Skip platform-restricted commands
      if (cmd.platforms && !cmd.platforms.includes(this.platform)) continue;

      const matches = cmd.exact
        ? cmd.names.includes(parsed.command)
        : cmd.names.some(name => parsed.command === name || parsed.command.startsWith(name));

      if (matches) {
        try {
          const handled = await cmd.handler(ctx);
          if (handled) return true;
        } catch (err) {
          console.error(`[command-router] Command /${parsed.command} error: ${err}`);
          return false;
        }
      }
    }

    return false;
  }

  /**
   * Parse a command string into command name and arguments.
   * Returns null if the text is not a valid command.
   */
  parse(text: string): { command: string; args: string } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;

    // Handle regex-style commands like /switch-account or /sa
    const match = trimmed.match(/^\/([a-zA-Z_][\w-]*)\s*(.*)?$/s);
    if (!match) return null;

    return {
      command: match[1].toLowerCase(),
      args: (match[2] ?? '').trim(),
    };
  }

  /**
   * Get all registered commands (for /help generation).
   */
  getRegisteredCommands(): Array<{
    names: string[];
    description?: string;
    platforms?: string[];
  }> {
    return this.commands
      .filter(cmd => !cmd.platforms || cmd.platforms.includes(this.platform))
      .map(cmd => ({
        names: cmd.names,
        description: cmd.description,
        platforms: cmd.platforms,
      }));
  }

  /**
   * Generate a help text listing all available commands.
   */
  generateHelp(): string {
    const available = this.getRegisteredCommands();
    if (available.length === 0) return 'No commands available.';

    const lines = available.map(cmd => {
      const primary = `/${cmd.names[0]}`;
      const aliases = cmd.names.length > 1
        ? ` (${cmd.names.slice(1).map(a => `/${a}`).join(', ')})`
        : '';
      const desc = cmd.description ? ` — ${cmd.description}` : '';
      return `${primary}${aliases}${desc}`;
    });

    return lines.join('\n');
  }
}
