# Run configurations

## Project run configurations

Use the run controls in the title bar to select, run, debug or stop a registered
project configuration. The settings button opens its configuration editor.
Useful Files, Agents and Skills stay below a spacer at the bottom of the right stripe.

Register a project from its file context menu:

- Right-click `package.json` and choose **Add as npm project**. Core saves the
  project settings and seeds named configurations from its scripts.
- Right-click `pom.xml` and choose **Add as Maven project**. This enables Java
  launch profiles and Maven/JDK settings.

Manifests can be in subdirectories. Registration opens the matching configuration
editor. Existing project settings are retained when the same project is added
again. Installed language services alone do not create top-bar run controls.

Use the title-bar settings button to edit, duplicate, rename or delete
configurations. Dirty editor files are saved before launch. Stop a running project
before editing its configuration. **Run** opens an interactive terminal tab for
the application. Its name comes from the selected configuration; input, Ctrl+C,
output replay and exit status use the normal terminal controls. Runs stay alive
when the renderer reconnects. The title-bar
Stop button terminates that run, and closing its terminal also stops it. Java
Debug continues to use the debugger controls.

### npm projects

The form includes the script, script arguments, Node options, working directory,
environment variables and an environment file. Arguments and Node options use
one entry per line; spaces within an entry are preserved. Environment variables
use `KEY=value`, one per line, and override values from the environment file.
Node options are appended to `NODE_OPTIONS` for the launched process.

Project tools select npm, pnpm or Yarn and an optional package-manager executable
on the Core host. By default, commands run in the manifest's directory. An explicit
working directory and environment-file path are relative to the workspace.
Settings are saved with revision checks in `.settings/npm.json`; scripts remain
in `package.json`.

### Maven / Java projects

Java profiles include the main class, program and JVM arguments, working
directory, environment variables/file, and active application profiles. Project
settings include Maven executable/arguments/goals, JDK home, source roots and
compiled output paths. Settings use `.settings/java.json`. See
[Java debugging](JAVA_DEBUGGING.md) for debugging and HotSwap behavior.

## Shell run configurations

Run configurations are reusable shell scripts that you launch from Vibe Editor. Use
them for build commands, development servers, or other commands you run often. Core
stores the scripts outside the checkout.

### Create and run a configuration

1. In **Useful Files**, choose the play-plus button in the **Global** or
   **Local** section.
2. Give the configuration a name and edit its shell script.
3. Use its button on the right of the bottom toolbar to run it or reopen its
   terminal. Right-click for **Open Terminal**, **Run**, **Stop**, or **Restart**.

Opening or listing a configuration does not run it. Names are plain file names
without directory separators. Vibe adds `.sh` to the stored file and leaves it out
of the displayed name. Global and local scripts can share a name; their scope
distinguishes them.

### Where commands run

Local scripts run in the active workspace or task worktree. Global scripts run in
the Core user's home directory. Scripts inherit Core's environment and use the same
terminal implementation as ordinary terminals. Their contents are passed to the
user's interactive shell.

Each configuration has a dedicated terminal. **Run** refuses a second active
invocation. **Stop** terminates its terminal and process tree. **Restart** waits for
the old terminal to exit before starting one new run. Completed output can be
reopened while Core remains running, including after Desktop reconnects.

### Storage

Scripts are UTF-8 files stored alongside Useful Files:

| Scope | Path under the state directory |
| --- | --- |
| Local | `run-configs/local/<workspace-hash>/<name>.sh` |
| Global | `run-configs/global/<name>.sh` |

The state directory is `REMOTE_IDE_STATE_DIR`, or `~/.remote-ide/workspaces` when
unset. The workspace hash is the SHA-256 hash of the selected project's root path.
Switching projects selects a different local collection; tasks within the same
project share that project's configurations.

## Configure with Vibe Configurator

The built-in Vibe Configurator agent can discover, read and edit the same settings
using `configuration_list`, `configuration_read` and `configuration_write`.
`languages/node.json` and `languages/java.json` expose complete project settings
and named profiles in the invoking checkout. Reading an unregistered project returns
plugin defaults; saving registers it. Shell configurations use
`runs/{local|global}/{name}.sh`. Pass the revision returned by the read to preserve
concurrent UI edits. Saving through these tools never launches a process.
