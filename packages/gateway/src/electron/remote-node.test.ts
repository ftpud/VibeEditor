import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { remoteNodeEnvironment } from "./remote-node.js";

const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

async function setup(versions: string[], systemVersion = "20.19.0", customNvm = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-nvm-"));
  const nvm = path.join(directory, customNvm ? "custom nvm" : ".nvm");
  const systemBin = path.join(directory, "system-bin");
  const install = async (bin: string, version: string) => {
    await mkdir(bin, { recursive: true });
    const preload = path.join(bin, "version.cjs");
    await writeFile(preload, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });`);
    await writeFile(path.join(bin, "node"), `#!/bin/sh\nexec ${quote(process.execPath)} --require ${quote(preload)} "$@"\n`, { mode: 0o755 });
    await writeFile(path.join(bin, "npm"), `#!/bin/sh\nexec node -e 'process.stdout.write("npm:" + process.versions.node)'\n`, { mode: 0o755 });
  };
  await install(systemBin, systemVersion);
  if (versions.length) {
    for (const version of versions) await install(path.join(nvm, "versions", "node", `v${version}`, "bin"), version);
    const latest = [...versions].sort((left, right) => left.localeCompare(right, undefined, { numeric: true })).at(-1)!;
    const preferred = versions.filter((version) => version.startsWith("24.")).sort((left, right) => left.localeCompare(right, undefined, { numeric: true })).at(-1);
    await mkdir(path.join(nvm, "alias"), { recursive: true });
    await writeFile(path.join(nvm, "alias", "default"), "20\n");
    await writeFile(path.join(nvm, "nvm.sh"), `
[ "\${1-}" = --no-use ] || { echo 'NVM must be loaded without its default' >&2; return 99; }
nvm() {
  case "$1" in
    version)
      case "$2" in
        24) ${preferred ? `printf '%s\\n' ${quote(`v${preferred}`)}` : "return 3"};;
        node) printf '%s\\n' ${quote(`v${latest}`)};;
        *) return 3;;
      esac;;
    use)
      shift
      [ "\${1-}" != --silent ] || shift
      export PATH="$NVM_DIR/versions/node/$1/bin:$PATH";;
    *) echo 'Unexpected NVM command' >&2; return 99;;
  esac
}
`);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: directory, PATH: `${systemBin}:/usr/bin:/bin` };
  if (customNvm) env.NVM_DIR = nvm; else delete env.NVM_DIR;
  const run = () => execute("/bin/bash", ["-eu", "-c", `${remoteNodeEnvironment}\nnode -e 'process.stdout.write(process.versions.node)'\nprintf '\\n'\nnpm --version`], { env });
  return { directory, nvm, run };
}

for (const customNvm of [false, true]) {
  test(`selects installed Node 24 for node and npm while preserving default 20${customNvm ? " in a custom NVM directory" : ""}`, async () => {
    const fixture = await setup(["20.19.0", "24.1.0", "24.5.0", "26.0.0"], "20.19.0", customNvm);
    try {
      assert.equal((await fixture.run()).stdout, "24.5.0\nnpm:24.5.0");
      assert.equal(await readFile(path.join(fixture.nvm, "alias/default"), "utf8"), "20\n");
    } finally { await rm(fixture.directory, { recursive: true, force: true }); }
  });
}

test("uses an installed supported NVM version when Node 24 is absent", async () => {
  const fixture = await setup(["20.19.0", "22.12.0"]);
  try { assert.equal((await fixture.run()).stdout, "22.12.0\nnpm:22.12.0"); }
  finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

for (const version of ["20.19.0", "22.11.0"]) {
  test(`rejects unsupported NVM Node ${version} with installation guidance`, async () => {
    const fixture = await setup([version]);
    try { await assert.rejects(fixture.run(), /requires Node.js 22.12\+.*nvm install 24/); }
    finally { await rm(fixture.directory, { recursive: true, force: true }); }
  });
}

test("supports hosts without NVM when PATH already provides a supported Node", async () => {
  const fixture = await setup([], "24.5.0");
  try { assert.equal((await fixture.run()).stdout, "24.5.0\nnpm:24.5.0"); }
  finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
