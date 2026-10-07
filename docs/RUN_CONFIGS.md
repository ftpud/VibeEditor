# Run configurations

Run configurations are reusable shell scripts that you launch from Vibe Editor. Use
them for build commands, development servers, or other commands you run often. Core
stores the scripts outside the checkout.

## Create and run a configuration

1. In **Useful Files**, choose the play-plus button in the **Global** or
   **Local** section.
2. Give the configuration a name and edit its shell script.
3. Use its button on the right of the bottom toolbar to run it or reopen its
   terminal. Right-click for **Open Terminal**, **Run**, **Stop**, or **Restart**.

Opening or listing a configuration does not run it. Names are plain file names
without directory separators. Vibe adds `.sh` to the stored file and leaves it out
of the displayed name. Global and local scripts can share a name; their scope
distinguishes them.

## Where commands run

Local scripts run in the active workspace or task worktree. Global scripts run in
the Core user's home directory. Scripts inherit Core's environment and use the same
terminal implementation as ordinary terminals. Their contents are passed to the
user's interactive shell.

Each configuration has a dedicated terminal. **Run** refuses a second active
invocation. **Stop** terminates its terminal and process tree. **Restart** waits for
the old terminal to exit before starting one new run. Completed output can be
reopened while Core remains running, including after Desktop reconnects.

## Storage

Scripts are UTF-8 files stored alongside Useful Files:

| Scope | Path under the state directory |
| --- | --- |
| Local | `run-configs/local/<workspace-hash>/<name>.sh` |
| Global | `run-configs/global/<name>.sh` |

The state directory is `REMOTE_IDE_STATE_DIR`, or `~/.remote-ide/workspaces` when
unset. The workspace hash is the SHA-256 hash of the selected project's root path.
Switching projects selects a different local collection; tasks within the same
project share that project's configurations.
