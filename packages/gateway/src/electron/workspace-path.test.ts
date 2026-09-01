import assert from "node:assert/strict";
import test from "node:test";
import { parseDiscoveredWorkspaceDirectories, parseValidatedWorkspaceDirectory, quoteWorkspaceShellArgument, validateWorkspaceDirectoryInput, workspaceDiscoveryCommand, workspaceRegistrationCommand, workspaceUnregistrationCommand, workspaceValidationCommand } from "./workspace-path.js";

test("workspace discovery includes direct home folders and is bounded", () => {
  const command = workspaceDiscoveryCommand();
  assert.match(command, /\.vibe\/workspaces/);
  assert.match(command, /while IFS= read -r child/);
  assert.match(command, /for name in projects Projects workspace workspaces code Code src repos repositories/);
  assert.match(command, /for child in \"\$HOME\"\/\*/);
  assert.match(command, /-d \"\$child\"/);
  assert.match(command, /count.*64/);
  assert.doesNotMatch(command, /find |maxdepth [2-9]|\*\*|\/etc/);
});

test("workspace registry commands safely add and remove exact paths", () => {
  const register = workspaceRegistrationCommand("/home/dev/project's api");
  const unregister = workspaceUnregistrationCommand("/home/dev/project's api");
  assert.match(register, /\.vibe\/workspaces/);
  assert.match(register, /grep -Fqx/);
  assert.match(unregister, /temporary=/);
  assert.match(unregister, /mv --/);
  assert.doesNotMatch(register, /project's api/);
  assert.doesNotMatch(unregister, /project's api/);
});

test("manual workspace paths must be safe absolute paths", () => {
  assert.equal(validateWorkspaceDirectoryInput(" /home/dev/project/ "), "/home/dev/project/");
  assert.throws(() => validateWorkspaceDirectoryInput("project"), /absolute path/);
  assert.throws(() => validateWorkspaceDirectoryInput("/home/dev/\nproject"), /control characters/);
  assert.match(workspaceValidationCommand("/home/dev/project"), /cd --/);
});

test("workspace validation shell-quotes apostrophes for both shell layers", () => {
  assert.equal(quoteWorkspaceShellArgument("/tmp/dev's app"), `'/tmp/dev'"'"'s app'`);
  assert.match(workspaceValidationCommand("/tmp/dev's app"), /directory=/);
});

test("remote directory results are strictly parsed and bounded", () => {
  assert.deepEqual(parseDiscoveredWorkspaceDirectories("/home/dev\n/home/dev/projects/api\nrelative\n/home/dev/projects/api\n"), ["/home/dev", "/home/dev/projects/api"]);
  assert.equal(parseValidatedWorkspaceDirectory("/srv/project\n"), "/srv/project");
  assert.throws(() => parseValidatedWorkspaceDirectory("/srv/a\n/srv/b\n"), /Could not validate/);
});
