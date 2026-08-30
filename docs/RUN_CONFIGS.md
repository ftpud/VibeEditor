# Run Configurations

Run Configurations are UTF-8 shell-script files. Workspace-local configurations live in `.vibe/run-configs/<name>.sh`; global configurations live in `$REMOTE_IDE_STATE_DIR/run-configs/<name>.sh`, or `~/.remote-ide/run-configs/<name>.sh` when that variable is unset. The file body is passed faithfully to the user's interactive terminal shell. Merely listing or opening a configuration never executes it.

Names are plain file names (no directory separators); `.sh` is added by Vibe Editor and omitted from the displayed name. Global and local configurations with the same name are both retained and identified by scope; neither silently overrides the other.

Local configurations run with the active workspace/task as their current directory. Global configurations run from the user's home directory. They inherit Core's environment and use the same cross-platform PTY implementation as ordinary terminals. Each configuration owns one dedicated terminal. Run rejects a duplicate active invocation; Stop terminates its PTY/process tree; Restart waits for that terminal to exit and then starts exactly one new run. Completed terminal output remains attachable for the lifetime of Core, including renderer reconnects.

Create configurations from the play-plus button beside the existing `+` in either Global or Local section of Useful Files. Every discovered configuration is pinned to the right of the bottom tool bar. Click it to open its terminal (or run it when it has no terminal); right-click for Open Terminal, Run, Stop, and Restart.
