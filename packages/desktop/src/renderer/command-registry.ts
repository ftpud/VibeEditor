/** A provider-neutral Desktop command contract. Commands carry their own availability
 * rather than relying on UI event names or button text. */
export type CommandCategory = "Project" | "Git" | "Terminal" | "Task" | "AI" | "Editor";

export type CommandContext = { connected: boolean; hasActiveEditor: boolean; activeEditorDirty: boolean; gitBusy: boolean; taskSwitching: boolean; aiBusy: boolean };

export type Command = {
  id: string;
  label: string;
  category: CommandCategory;
  shortcut?: string;
  when?(context: CommandContext): boolean;
  execute(): void | Promise<void>;
};

export function commandEnabled(command: Command, context: CommandContext): boolean {
  return command.when?.(context) ?? true;
}

export function rankCommands(commands: Command[], query: string): Command[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((command) => terms.every((term) => `${command.label} ${command.category} ${command.id}`.toLocaleLowerCase().includes(term)));
}
