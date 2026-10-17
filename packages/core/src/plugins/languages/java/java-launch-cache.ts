import crypto from "node:crypto";
import path from "node:path";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import type { JavaProjectOptions } from "@remote-ide/protocol";

/** Launch profiles do not affect compilation or the dependency classpath. */
export function javaBuildKey(workspace: string, options: JavaProjectOptions): string {
  const { runConfigurations: _profiles, selectedRunConfigurationId: _selected, ...build } = options;
  return JSON.stringify({ workspace, build, javaHome: process.env.JAVA_HOME, mavenOpts: process.env.MAVEN_OPTS, mavenArgs: process.env.MAVEN_ARGS });
}

export async function javaBuildFingerprint(workspace: string, options: JavaProjectOptions): Promise<string> {
  const inputs = new Set<string>(options.sourceRoots.map((root) => path.resolve(workspace, root)));
  inputs.add(path.resolve(workspace, options.pomPath));
  if (options.mavenExecutable.includes("/") || options.mavenExecutable.includes("\\")) inputs.add(path.resolve(workspace, options.mavenExecutable));
  for (const [index, argument] of (options.mavenArguments ?? []).entries()) {
    if (["-s", "--settings", "-gs", "--global-settings"].includes(argument) && options.mavenArguments?.[index + 1]) inputs.add(path.resolve(workspace, options.mavenArguments[index + 1]!));
  }
  const excluded = new Set([".git", "node_modules", "target", ".tools", ".electron-runtime"]);
  let unresolvedDirectory = false;
  const outputs = [options.outputPath, options.testOutputPath].map((root) => path.resolve(workspace, root));
  const discover = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (outputs.includes(file)) continue;
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        if (entry.name === "src" || entry.name === ".mvn") inputs.add(file);
        else await discover(file);
      } else if (entry.name === "pom.xml" || ["mvnw", "mvnw.cmd", "settings.xml"].includes(entry.name)) {
        inputs.add(file);
        if (entry.name === "pom.xml") {
          const pom = new XMLParser().parse(await readFile(file, "utf8"));
          // Include custom source/resource directories, including profile-specific ones.
          const directories = (value: unknown): void => {
            if (!value || typeof value !== "object") return;
            for (const [key, item] of Object.entries(value)) {
              if (["sourceDirectory", "testSourceDirectory", "directory"].includes(key) && typeof item === "string") {
                const properties = { ...pom.project?.properties, "project.basedir": directory, basedir: directory } as Record<string, unknown>;
                let resolved = item;
                for (let pass = 0; pass < 10 && resolved.includes("${"); pass++) {
                  const previous = resolved;
                  resolved = resolved.replace(/\$\{([^}]+)\}/g, (original, key: string) => typeof properties[key] === "string" || typeof properties[key] === "number" ? String(properties[key]) : original);
                  if (previous === resolved) break;
                }
                if (resolved.includes("${")) unresolvedDirectory = true;
                else {
                  const absolute = path.resolve(directory, resolved);
                  const relative = path.relative(workspace, absolute);
                  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && !outputs.includes(absolute)) inputs.add(absolute);
                }
              } else directories(item);
            }
          };
          const buildDirectories = (build: Record<string, unknown> | undefined) => {
            if (!build) return;
            directories({ sourceDirectory: build.sourceDirectory, testSourceDirectory: build.testSourceDirectory, resources: build.resources, testResources: build.testResources });
          };
          buildDirectories(pom.project?.build);
          const profiles = pom.project?.profiles?.profile;
          for (const profile of profiles ? (Array.isArray(profiles) ? profiles : [profiles]) : []) buildDirectories(profile.build);
        }
      }
    }
  };
  await discover(workspace);
  return unresolvedDirectory ? crypto.randomUUID() : fingerprintPaths([...inputs]);
}

export function javaOutputFingerprint(workspace: string, options: JavaProjectOptions): Promise<string> {
  return fingerprintPaths([options.outputPath, options.testOutputPath].map((root) => path.resolve(workspace, root)));
}

async function fingerprintPaths(paths: string[]): Promise<string> {
  const hash = crypto.createHash("sha256");
  const visited = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    hash.update(JSON.stringify(file));
    let info;
    try { info = await stat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { hash.update("missing"); return; } throw error; }
    const resolved = await realpath(file);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    if (info.isDirectory()) {
      for (const entry of (await readdir(file, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        await visit(path.join(file, entry.name));
      }
    } else if (info.isFile()) hash.update(await readFile(file));
  };
  for (const file of paths.sort()) await visit(file);
  return hash.digest("hex");
}
