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
