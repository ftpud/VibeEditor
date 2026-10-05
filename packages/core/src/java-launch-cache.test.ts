import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { JavaProjectOptions } from "@remote-ide/protocol";
import { javaBuildFingerprint, javaOutputFingerprint } from "./java-launch-cache.js";

it("tracks custom resources, Maven wrapper configuration, source deletion, and output removal", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "vibe-java-cache-"));
  const options: JavaProjectOptions = { type: "maven", pomPath: "pom.xml", mavenExecutable: "mvn", sourceRoots: ["src/main/java"], outputPath: "target/classes", testOutputPath: "target/test-classes", runConfigurations: [] };
  try {
    for (const directory of ["src/main/java", "assets", ".mvn", "target/classes"]) await mkdir(path.join(workspace, directory), { recursive: true });
    await writeFile(path.join(workspace, "pom.xml"), "<project><properties><assets>assets</assets></properties><build><resources><resource><directory>${assets}</directory></resource></resources></build></project>");
    await writeFile(path.join(workspace, "src/main/java/App.java"), "class App {}");
    const before = await javaBuildFingerprint(workspace, options);
    await writeFile(path.join(workspace, "run.log"), "Runtime output");
    await writeFile(path.join(workspace, "target/classes/App.class"), "compiled output");
    expect(await javaBuildFingerprint(workspace, options)).toBe(before);
    await writeFile(path.join(workspace, "assets/config.json"), "{}");
    const resource = await javaBuildFingerprint(workspace, options);
    expect(resource).not.toBe(before);
    await writeFile(path.join(workspace, ".mvn/jvm.config"), "-Xmx512m");
    const wrapper = await javaBuildFingerprint(workspace, options);
    expect(wrapper).not.toBe(resource);
    await rm(path.join(workspace, "src/main/java/App.java"));
    expect(await javaBuildFingerprint(workspace, options)).not.toBe(wrapper);
    const outputs = await javaOutputFingerprint(workspace, options);
    await rm(path.join(workspace, "target/classes"), { recursive: true });
    expect(await javaOutputFingerprint(workspace, options)).not.toBe(outputs);
    // An unresolved inherited resource property conservatively disables reuse.
    await writeFile(path.join(workspace, "pom.xml"), "<project><build><resources><resource><directory>${inherited.assets}</directory></resource></resources></build></project>");
    expect(await javaBuildFingerprint(workspace, options)).not.toBe(await javaBuildFingerprint(workspace, options));
    // Source symlink cycles must not hang the launch check.
    await symlink(path.join(workspace, "src"), path.join(workspace, "src/main/java/cycle"));
    await writeFile(path.join(workspace, "pom.xml"), "<project />");
    expect(await javaBuildFingerprint(workspace, options)).toBe(await javaBuildFingerprint(workspace, options));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
