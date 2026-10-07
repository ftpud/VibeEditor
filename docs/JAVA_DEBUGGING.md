# Java debugging

Load a Maven project, select a run configuration, set line breakpoints in Java
source files, and choose **Debug**. Core builds the project with line and local
variable debug information and launches `jdb` from the project JDK.

When execution pauses, the Java panel shows the current location and local
variables. Expand the arrows to inspect object fields, inherited fields, nested
objects, and array elements. Instance methods also expose `this`. Arrays load up
to 50 elements per request; choose **Load more elements** for the next page.
Inspection reads fields without calling application methods or `toString`.
Objects identified by the same JVM object ID are the same instance. Values are
valid for the current pause and refresh after stepping or continuing.

## Apply code changes without restarting

1. Pause at a breakpoint and edit the source.
2. Choose **Apply code changes**. Desktop saves dirty workspace files; Core runs
   Maven `compile test-compile` and reloads changed, loaded classes through Java
   HotSwap. The application remains paused during compilation and reload.
3. Read the result in the debugger, then continue or step.

Successful reloads preserve existing objects, field values, and application
state. Changed classes that have not been loaded yet use the new bytecode when
first loaded. A compilation or save failure prevents reload; fix the error and
retry. If some classes reload and others fail, the result lists both outcomes.
The editor never restarts the application automatically.

Standard JVM HotSwap supports method-body changes. Adding/removing fields or
methods, changing inheritance, and similar structural edits usually require
restarting the debug session. Existing active calls continue executing their
previous bytecode until they return; subsequent calls use the new code. Static
initializers and constructors are not rerun for existing instances. Resource
files and dependency changes are not applied by this action.

Class reload clears JVM breakpoints for the affected classes. Core restores the
session's original line breakpoints and reports restoration failures. If edits
move a breakpoint off an executable line, adjust it and restart debugging.
Source line numbers in an active old method may still refer to the old code.
See the [Java class redefinition specification](https://docs.oracle.com/en/java/javase/21/docs/specs/jdwp/jdwp-protocol.html#VirtualMachine_RedefineClasses).

Core needs a project JDK providing `java`, `javac`, and `jdb`, plus the configured
Maven executable. Apply is available in a paused debug session, not in a normal
Java run. Class redefinition support and restrictions are determined by the JVM.

## Configure Maven, Java, and launch profiles

Open **Java run/debug configuration** with the gear beside the launch-profile
selector or in the Java panel. You can also find it in the command palette.
The editor has a form and a JSON tab with an **Insert template** action. Saving
writes `.settings/java.json` in the remote workspace. Existing workspace settings
are used until you save this file; subsequent runs read the JSON file directly.
When `.settings/java.json` is absent, Core copies an existing `.vibe/java.json`
there and keeps the original as a backup.
`.settings/java.json` takes precedence when multiple locations exist.
You can edit it in the regular file editor too. Invalid JSON stays available for
repair, and the configuration dialog checks the file revision before overwriting
an externally edited file.

Configure **Maven executable** as `mvn`, `./mvnw`, or the full executable path on
the Core host. Loading a Maven project detects a wrapper beside its pom.xml or
at the workspace root. Maven arguments, such as `-Pdevelopment`, have their own
field. Build goals default to `package` and `-DskipTests` and run before both Run
and Debug. The project pom.xml controls compiler/plugin details.

**JDK home** is a JDK directory, such as `/usr/lib/jvm/java-21-openjdk`, rather
than the `bin/java` executable. Blank uses the Core host's `JAVA_HOME` or `PATH`.
An explicit JDK home selects its Java and debugger binaries and sets `JAVA_HOME`
and `PATH` for Maven. **Check tools** runs version checks for Maven, Java, javac,
and jdb using the unsaved draft settings.

Create, rename, duplicate, or remove launch profiles in the form. Choose the
profile used for Run/Debug, set a main class, and optionally supply program
arguments, VM arguments, application environment variables, and a working
directory relative to the workspace (`.` means its root). Form argument lists
use one argument per line; a line containing spaces is one argument. Shell
quoting is unnecessary. JSON supports empty arguments as well.

For example, the launch-specific part of a profile can be:

```json
{
  "id": "development",
  "name": "Development",
  "mainClass": "com.example.App",
  "programArguments": ["--message", "hello world"],
  "vmArguments": ["-ea", "-Xmx1g", "-Dapp.mode=development"],
  "workingDirectory": ".",
  "environment": { "APP_MODE": "development" }
}
```

If a build previously reported `spawn mvn ENOENT`, the Core host could not find
Maven in its environment. Choose a project wrapper or the full installed Maven
path, check the tools, save, and retry. A permission error on a wrapper means its
script needs execute permission, such as `chmod +x mvnw` on the Core host. A
wrapper also needs its script interpreter to be installed.

Run now builds and launches the configured main class directly using Java,
without depending on Maven's exec plugin. Debug starts the same application JVM
with a local-only debugging connection and attaches jdb. Application output is
kept separate from debugger command output. Stop the Java process before saving
configuration changes; applying method-body edits uses the session's original
build/tool settings until you start a new session.
