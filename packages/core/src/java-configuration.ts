import { parse as parseEnv } from "dotenv";
import os from "node:os";
import path from "node:path";
import { javaConfigurationPath, type FileRevision, type JavaProjectOptions, type JavaRunConfiguration } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import type { WorkspaceFileSystem } from "./filesystem.js";
import { validateJavaProjectOptions } from "./workspace-state.js";

export function parseJavaConfiguration(content: string): JavaProjectOptions {
  if (typeof content !== "string" || Buffer.byteLength(content) > 200_000) throw new CoreError("INVALID_REQUEST", "Java configuration must be JSON text under 200 KB");
  let value: unknown;
  try { value = JSON.parse(content); }
  catch (error) { throw new CoreError("INVALID_REQUEST", `${javaConfigurationPath}: invalid JSON. ${error instanceof Error ? error.message : String(error)}`); }
  try { return validateJavaProjectOptions(value); }
  catch (error) { throw new CoreError("INVALID_REQUEST", `${javaConfigurationPath}: ${error instanceof Error ? error.message : String(error)}`); }
}

export function javaConfigurationTemplate(options: JavaProjectOptions): string {
  const profiles = options.runConfigurations.length ? options.runConfigurations : [{ id: "application", name: "Application", mainClass: "com.example.App" }];
  return JSON.stringify({
    ...options, javaHome: options.javaHome ?? "", mavenArguments: options.mavenArguments ?? [], buildGoals: options.buildGoals ?? ["package", "-DskipTests"],
    runConfigurations: profiles.map((profile) => ({ ...profile, programArguments: profile.programArguments ?? [], vmArguments: profile.vmArguments ?? [], workingDirectory: profile.workingDirectory ?? ".", environment: profile.environment ?? {} })),
    selectedRunConfigurationId: options.selectedRunConfigurationId ?? profiles[0]!.id
  }, null, 2) + "\n";
}

export async function readJavaConfiguration(filesystem: WorkspaceFileSystem): Promise<{ content: string; revision: FileRevision } | undefined> {
  try { return await filesystem.read(javaConfigurationPath); }
  catch (error) { if (!(error instanceof CoreError) || error.code !== "FILE_NOT_FOUND") throw error; }
  let legacy: { content: string; revision: FileRevision };
  try { legacy = await filesystem.read(".vibe/java.json"); }
  catch (error) { if (error instanceof CoreError && error.code === "FILE_NOT_FOUND") return undefined; throw error; }
  await ensureJavaConfigurationDirectory(filesystem);
  try { await filesystem.write(javaConfigurationPath, legacy.content, undefined, false, true); }
  catch (error) {
    // Another session may have migrated or created the configuration first.
    try { return await filesystem.read(javaConfigurationPath); } catch { throw error; }
  }
  return filesystem.read(javaConfigurationPath);
}

async function ensureJavaConfigurationDirectory(filesystem: WorkspaceFileSystem): Promise<void> {
  const directory = path.posix.dirname(javaConfigurationPath);
  try { await filesystem.resolveExisting(directory); }
  catch (error) {
    if (!(error instanceof CoreError) || error.code !== "FILE_NOT_FOUND") throw error;
    try { await filesystem.createDirectory(directory); }
    catch (createError) { try { await filesystem.resolveExisting(directory); } catch { throw createError; } }
  }
}

export async function writeJavaConfiguration(filesystem: WorkspaceFileSystem, content: string, expectedRevision?: FileRevision): Promise<FileRevision> {
  await ensureJavaConfigurationDirectory(filesystem);
  if (!expectedRevision && await readJavaConfiguration(filesystem)) throw new CoreError("FILE_CHANGED", "Java configuration changed. Reopen the editor to load the latest file before saving.");
  return (await filesystem.write(javaConfigurationPath, content, expectedRevision, false, !expectedRevision)).revision;
}

export function expandJavaToolPath(value: string, workspace: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.isAbsolute(value) ? value : value.includes("/") || value.includes("\\") ? path.resolve(workspace, value) : value;
}

export function javaToolExecutable(options: JavaProjectOptions, tool: string, workspace: string): string {
  const home = options.javaHome || process.env.JAVA_HOME;
  return home ? path.join(expandJavaToolPath(home, workspace), "bin", process.platform === "win32" ? `${tool}.exe` : tool) : tool;
}

export function javaToolEnvironment(options: JavaProjectOptions, workspace: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...extra };
  if (options.javaHome) {
    const home = expandJavaToolPath(options.javaHome, workspace);
    environment.JAVA_HOME = home;
    environment.PATH = `${path.join(home, "bin")}${path.delimiter}${environment.PATH ?? ""}`;
  }
  return environment;
}

export function javaSpawnError(error: Error, executable: string, label: string): CoreError {
  const code = (error as NodeJS.ErrnoException).code;
  const maven = label === "Maven" || label !== "Java compiler" && /(?:mvn|maven|build|compile|classpath)/i.test(`${path.basename(executable)} ${label}`);
  const setting = maven ? "Maven executable" : "JDK home";
  const advice = maven ? "Choose the project's ./mvnw wrapper or the full path to your Maven installation." : "Choose a full JDK installation that includes java, javac, and jdb.";
  if (code === "ENOENT") return new CoreError("JAVA_PROCESS_FAILED", `${label}: "${executable}" was not found on the Core host. Open Java configuration → ${setting}. ${advice} These tools run on the Core host, not your desktop. If the executable exists, check that the working directory and script interpreter exist too.`);
  if (code === "EACCES") return new CoreError("JAVA_PROCESS_FAILED", `${label}: permission denied for "${executable}" on the Core host. Make the file executable (for example, chmod +x mvnw) or choose another executable in Java configuration.`);
  return new CoreError("JAVA_PROCESS_FAILED", `${label} could not start "${executable}": ${error.message}`);
}

/** File variables are reloaded on every launch; inline profile variables take precedence. */
export async function javaLaunchEnvironment(filesystem: WorkspaceFileSystem, profile: JavaRunConfiguration): Promise<Record<string, string>> {
  let fileEnvironment: Record<string, string> = {};
  if (profile.environmentFile) {
    try {
      const { content } = await filesystem.read(profile.environmentFile);
      const value = parseEnv(content);
      if (Object.keys(value).length === 0 && content.split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith("#"))) throw new Error("Expected .env entries in KEY=value format");
      if (!value || typeof value !== "object" || Array.isArray(value) || !Object.entries(value).every(([key, item]) => /^[A-Za-z_][\w]*$/.test(key) && typeof item === "string" && !item.includes("\0"))) throw new Error("Environment file must contain valid variable names and string values without NUL characters");
      fileEnvironment = value as Record<string, string>;
    } catch (error) {
      throw new CoreError("INVALID_REQUEST", `Environment file ${profile.environmentFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ...fileEnvironment, ...profile.environment, ...(profile.activeProfile?.trim() ? { SPRING_PROFILES_ACTIVE: profile.activeProfile.trim() } : {}) };
}
