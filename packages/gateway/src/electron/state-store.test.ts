import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonStateStore } from "./state-store.js";

type State = { values: string[] };
const decode = (text: string): State => {
  const value = JSON.parse(text) as State;
  if (!value || !Array.isArray(value.values)) throw new Error("invalid state shape");
  return value;
};

async function fixture(): Promise<{ directory: string; file: string; store: JsonStateStore<State>; close: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-state-store-"));
  const file = path.join(directory, "gateway.json");
  return { directory, file, store: new JsonStateStore(file, () => ({ values: [] }), decode), close: () => rm(directory, { recursive: true, force: true }) };
}

test("uses defaults only when both state files are missing", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.store.read(), { values: [] });
    await writeFile(`${f.file}.bak`, JSON.stringify({ values: ["saved"] }));
    assert.deepEqual(await f.store.read(), { values: ["saved"] });
    assert.deepEqual(decode(await readFile(f.file, "utf8")), { values: ["saved"] });
  } finally { await f.close(); }
});

test("atomically preserves a last-good backup and restores corrupt primary state", async () => {
  const f = await fixture();
  try {
    await f.store.update((state) => { state.values.push("first"); });
    await f.store.update((state) => { state.values.push("second"); });
    assert.deepEqual(decode(await readFile(`${f.file}.bak`, "utf8")), { values: ["first"] });
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
    assert.equal((await stat(`${f.file}.bak`)).mode & 0o777, 0o600);
    await writeFile(f.file, "{broken");
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...items: unknown[]) => warnings.push(items.join(" "));
    let recovered: State;
    try { recovered = await f.store.read(); }
    finally { console.warn = warn; }
    assert.deepEqual(recovered!, { values: ["first"] });
    assert.match(warnings.join("\n"), /corrupt; restoring last-good backup/);
    assert.deepEqual(decode(await readFile(f.file, "utf8")), { values: ["first"] });
  } finally { await f.close(); }
});

test("serializes complete asynchronous read-modify-write transactions", async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => f.store.update(async (state) => {
      const previous = state.values.length;
      await new Promise((resolve) => setTimeout(resolve, index % 3));
      state.values.push(String(previous));
    })));
    assert.deepEqual((await f.store.read()).values, Array.from({ length: 12 }, (_, index) => String(index)));
  } finally { await f.close(); }
});

test("queues public reads behind an in-flight update", async () => {
  const f = await fixture();
  try {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const update = f.store.update(async (state) => {
      state.values.push("committed");
      markStarted();
      await gate;
    });
    await started;
    const read = f.store.read();
    release();
    await update;
    assert.deepEqual(await read, { values: ["committed"] });
  } finally { await f.close(); }
});

test("throws a diagnostic when primary and backup are both corrupt", async () => {
  const f = await fixture();
  try {
    await writeFile(f.file, "broken primary");
    await writeFile(`${f.file}.bak`, "broken backup");
    await assert.rejects(f.store.read(), new RegExp(`${path.basename(f.file)}.*${path.basename(f.file)}\\.bak`));
  } finally { await f.close(); }
});
