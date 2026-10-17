import type { JavaBreakpoint, JavaProjectOptions, JavaRunConfiguration } from "@remote-ide/protocol";
import { CoreError } from "../../../errors.js";
import { isSafeRelativePath } from "../../../path-safety.js";
import { registerWorkspaceStateValidator } from "../../../workspace-state.js";

/** Validation for Java-only workspace data (`.settings/java.json`, breakpoints), owned by the Java language service. */
export function validateJavaBreakpoints(value: unknown): JavaBreakpoint[] {
  if (!Array.isArray(value) || value.length > 1000) throw new CoreError("INVALID_REQUEST", "Invalid Java breakpoints");
  const seen = new Set<string>();
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") throw new CoreError("INVALID_REQUEST", "Invalid Java breakpoint");
    const { path: filePath, line, className } = item as Record<string, unknown>;
    if (!isSafeRelativePath(filePath) || !/\.java$/i.test(filePath) || !Number.isSafeInteger(line) || (line as number) < 1 || typeof className !== "string" || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(className)) throw new CoreError("INVALID_REQUEST", "Invalid Java breakpoint");
    const key = `${filePath}:${line}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ path: filePath, line: line as number, className }];
  });
}

export function validateJavaProjectOptions(value: unknown): JavaProjectOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CoreError("INVALID_REQUEST", "Java configuration must be a JSON object");
  const candidate = value as Record<string, unknown>;
  rejectUnknownJavaFields(candidate, ["type", "pomPath", "mavenExecutable", "javaHome", "mavenArguments", "buildGoals", "sourceRoots", "outputPath", "testOutputPath", "runConfigurations", "selectedRunConfigurationId"], "Java configuration");
  if (candidate.type !== "maven") throw new CoreError("INVALID_REQUEST", 'type must be "maven"');
  if (!isSafeRelativePath(candidate.pomPath)) throw new CoreError("INVALID_REQUEST", "pomPath must be a path inside the workspace, such as pom.xml");
  if (typeof candidate.mavenExecutable !== "string" || !candidate.mavenExecutable.trim() || candidate.mavenExecutable.length > 1000 || /[\0\r\n]/.test(candidate.mavenExecutable)) throw new CoreError("INVALID_REQUEST", "mavenExecutable must be an executable name or path, such as mvn or ./mvnw");
  if (candidate.javaHome !== undefined && (typeof candidate.javaHome !== "string" || candidate.javaHome.length > 1000 || /[\0\r\n]/.test(candidate.javaHome))) throw new CoreError("INVALID_REQUEST", "javaHome must be a JDK directory on the Core host");
  if (!Array.isArray(candidate.sourceRoots) || candidate.sourceRoots.length > 50 || !candidate.sourceRoots.every(isSafeRelativePath)) throw new CoreError("INVALID_REQUEST", "sourceRoots must contain paths inside the workspace");
  if (!isSafeRelativePath(candidate.outputPath) || !isSafeRelativePath(candidate.testOutputPath)) throw new CoreError("INVALID_REQUEST", "outputPath and testOutputPath must be paths inside the workspace");
  const mavenArguments = javaArgumentList(candidate.mavenArguments, "mavenArguments");
  const buildGoals = javaArgumentList(candidate.buildGoals, "buildGoals");
  if (buildGoals?.length === 0) throw new CoreError("INVALID_REQUEST", "buildGoals must contain at least one Maven goal");
  const rawConfigurations = candidate.runConfigurations ?? [];
  if (!Array.isArray(rawConfigurations) || rawConfigurations.length > 50) throw new CoreError("INVALID_REQUEST", "runConfigurations must be an array of at most 50 launch profiles");
  const runConfigurations = rawConfigurations.map(validateRunConfiguration);
  if (new Set(runConfigurations.map((item) => item.id)).size !== runConfigurations.length) throw new CoreError("INVALID_REQUEST", "Each launch profile must have a different id");
  const selectedRunConfigurationId = candidate.selectedRunConfigurationId;
  if (selectedRunConfigurationId !== undefined && (typeof selectedRunConfigurationId !== "string" || !runConfigurations.some((item) => item.id === selectedRunConfigurationId))) throw new CoreError("INVALID_REQUEST", "selectedRunConfigurationId must match a launch profile id");
  return {
    type: "maven", pomPath: candidate.pomPath, mavenExecutable: candidate.mavenExecutable.trim(),
    sourceRoots: [...new Set(candidate.sourceRoots as string[])], outputPath: candidate.outputPath, testOutputPath: candidate.testOutputPath,
    runConfigurations,
    ...(typeof candidate.javaHome === "string" && candidate.javaHome.trim() ? { javaHome: candidate.javaHome.trim() } : {}),
    ...(mavenArguments ? { mavenArguments } : {}), ...(buildGoals ? { buildGoals } : {}),
    ...(typeof selectedRunConfigurationId === "string" ? { selectedRunConfigurationId } : {})
  };
}

function javaArgumentList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 200 || !value.every((item) => typeof item === "string" && item.length <= 10_000 && !item.includes("\0"))) throw new CoreError("INVALID_REQUEST", `${field} must be an array of strings (one argument per item)`);
  return value as string[];
}

function rejectUnknownJavaFields(value: Record<string, unknown>, fields: string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !fields.includes(key));
  if (unknown) throw new CoreError("INVALID_REQUEST", `${label}: unknown field "${unknown}"`);
}

function validateRunConfiguration(value: unknown): JavaRunConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CoreError("INVALID_REQUEST", "Each launch profile must be an object");
  const candidate = value as Record<string, unknown>;
  rejectUnknownJavaFields(candidate, ["id", "name", "mainClass", "activeProfile", "programArguments", "vmArguments", "workingDirectory", "environmentFile", "environment"], "Launch profile");
  if (typeof candidate.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(candidate.id)) throw new CoreError("INVALID_REQUEST", "Launch profile id must use letters, numbers, or hyphens");
  if (typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 100) throw new CoreError("INVALID_REQUEST", "Launch profile name is required (up to 100 characters)");
  if (typeof candidate.mainClass !== "string" || !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(candidate.mainClass)) throw new CoreError("INVALID_REQUEST", `Launch profile "${candidate.name}": mainClass must be a Java class name, such as com.example.App`);
  if (candidate.activeProfile !== undefined && (typeof candidate.activeProfile !== "string" || candidate.activeProfile.length > 1000 || candidate.activeProfile.includes("\0") || /[\r\n]/.test(candidate.activeProfile))) throw new CoreError("INVALID_REQUEST", "activeProfile must be a string without NUL characters or line breaks (up to 1000 characters)");
  const programArguments = javaArgumentList(candidate.programArguments, "programArguments");
  const vmArguments = javaArgumentList(candidate.vmArguments, "vmArguments");
  if (candidate.workingDirectory !== undefined && !isSafeRelativePath(candidate.workingDirectory)) throw new CoreError("INVALID_REQUEST", "workingDirectory must be inside the workspace; use . for its root");
  if (candidate.environmentFile !== undefined && !isSafeRelativePath(candidate.environmentFile)) throw new CoreError("INVALID_REQUEST", "environmentFile must be an .env file inside the workspace");
  if (candidate.environment !== undefined && (!candidate.environment || typeof candidate.environment !== "object" || Array.isArray(candidate.environment) || Object.keys(candidate.environment).length > 100 || !Object.entries(candidate.environment).every(([key, item]) => /^[A-Za-z_][\w]*$/.test(key) && typeof item === "string" && item.length <= 10_000 && !item.includes("\0")))) throw new CoreError("INVALID_REQUEST", "environment must be a JSON object mapping environment variable names to strings");
  return {
    id: candidate.id, name: candidate.name.trim(), mainClass: candidate.mainClass,
    ...(typeof candidate.activeProfile === "string" && candidate.activeProfile.trim() ? { activeProfile: candidate.activeProfile.trim() } : {}),
    ...(programArguments ? { programArguments } : {}), ...(vmArguments ? { vmArguments } : {}),
    ...(typeof candidate.workingDirectory === "string" ? { workingDirectory: candidate.workingDirectory } : {}),
    ...(typeof candidate.environmentFile === "string" ? { environmentFile: candidate.environmentFile } : {}),
    ...(candidate.environment ? { environment: candidate.environment as Record<string, string> } : {})
  };
}


// The Java plugin owns these workspace-state fields; registering on load keeps them validated wherever Java code runs.
registerWorkspaceStateValidator("javaBreakpoints", validateJavaBreakpoints);
registerWorkspaceStateValidator("javaProject", validateJavaProjectOptions);
