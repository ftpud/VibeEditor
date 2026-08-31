import { useState, type KeyboardEvent } from "react";
import {
  formatShortcut,
  shortcutConflict,
  shortcutFromEvent,
  type Command,
  type CommandId,
  type DesktopPlatform,
  type ShortcutBindings,
} from "./command-registry";
export function ShortcutSettings({
  commands,
  bindings,
  platform,
  onChange,
  onReset,
}: {
  commands: Command[];
  bindings: ShortcutBindings;
  platform: DesktopPlatform;
  onChange(id: CommandId, shortcut?: string): void;
  onReset(): void;
}) {
  const [editing, setEditing] = useState<CommandId>();
  const [error, setError] = useState("");
  const capture = (id: CommandId, event: KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setEditing(undefined);
      setError("");
      return;
    }
    if (["Backspace", "Delete"].includes(event.key)) {
      onChange(id);
      setEditing(undefined);
      setError("");
      return;
    }
    const shortcut = shortcutFromEvent(event.nativeEvent);
    if (!shortcut) return;
    const conflict = shortcutConflict(id, shortcut, bindings, platform);
    if (conflict) {
      setError(conflict);
      return;
    }
    onChange(id, shortcut);
    setEditing(undefined);
    setError("");
  };
  const configurable = commands;
  return (
    <section
      className="shortcut-settings"
      aria-labelledby="shortcut-settings-title"
    >
      <div className="shortcut-settings-header">
        <strong id="shortcut-settings-title">Keyboard shortcuts</strong>
        <button onClick={onReset}>Reset all</button>
      </div>
      <small>
        Choose a command, then press a shortcut. Backspace clears it.
      </small>
      {configurable.map((command) => (
        <div className="shortcut-row" key={command.id}>
          <label htmlFor={`shortcut-${command.id}`}>{command.label}</label>
          <button
            id={`shortcut-${command.id}`}
            aria-label={`${command.label} shortcut`}
            aria-pressed={editing === command.id}
            onClick={() => {
              setEditing(command.id);
              setError("");
            }}
            onKeyDown={(event) =>
              editing === command.id && capture(command.id, event)
            }
          >
            {editing === command.id
              ? "Press keys…"
              : bindings[command.id]
                ? formatShortcut(bindings[command.id]!, platform)
                : "Unassigned"}
          </button>
        </div>
      ))}
      {error && (
        <p className="shortcut-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
