import assert from "node:assert/strict";
import test from "node:test";
import { parseDiscoveredWorkspaceDirectories, parseValidatedWorkspaceDirectory, quoteWorkspaceShellArgument, validateWorkspaceDirectoryInput, workspaceDiscoveryCommand, workspaceValidationCommand } from "./workspace-path.js";

test("workspace discovery includes direct home folders and is bounded", () => {
  const command = workspaceDiscoveryCommand();
  assert.match(command, /for name in projects Projects workspace workspaces code Code src repos repositories/);
  assert.match(command, /for child in \"\$HOME\"\/\*/);
  assert.match(command, /-d \"\$child\"/);
  assert.match(command, /count.*64/);
  assert.doesNotMatch(command, /find |maxdepth [2-9]|\*\*|\/etc/);
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
