import type { ToolSpec } from "../../../tools.js";

/** Tools the Java language service needs on the Core host: a JRE for the language server and JDT LS itself. */
const TEMURIN = "21.0.8+9";
const JDTLS = "1.61.0-202608051627";
const temurinPlatform = () => {
  const osName = ({ darwin: "mac", linux: "linux", win32: "windows" } as Record<string, string>)[process.platform];
  const architecture = ({ arm64: "aarch64", x64: "x64" } as Record<string, string>)[process.arch];
  if (!osName || !architecture) throw new Error(`No Java runtime is available for ${process.platform}/${process.arch}`);
  return { osName, architecture };
};

export const JAVA_TOOLS: readonly ToolSpec[] = [
  {
    id: "java", name: "Java runtime", description: `Eclipse Temurin ${TEMURIN} JRE. Runs the Java language server only; builds, runs and debugging use the project's own JDK.`, version: TEMURIN, stripRoot: true,
    async source() {
      const { osName, architecture } = temurinPlatform();
      const format = osName === "windows" ? "zip" : "tar.gz";
      const base = `https://github.com/adoptium/temurin21-binaries/releases/download/jdk-${encodeURIComponent(TEMURIN)}`;
      const file = `OpenJDK21U-jre_${architecture}_${osName}_hotspot_${TEMURIN.replace("+", "_")}.${format}`;
      // Temurin publishes one checksum per platform archive next to it.
      const response = await fetch(`${base}/${file}.sha256.txt`);
      if (!response.ok) throw new Error(`Java runtime checksum download failed: HTTP ${response.status}`);
      return { url: `${base}/${file}`, sha256: (await response.text()).trim().split(/\s+/)[0]!, format };
    },
    entry: () => process.platform === "darwin" ? "Contents/Home/bin/java" : process.platform === "win32" ? "bin/java.exe" : "bin/java"
  },
  {
    id: "jdtls", name: "Java language server", description: `Eclipse JDT LS ${JDTLS}. Java highlighting, completion, navigation and symbols.`, version: JDTLS, requires: ["java"],
    async source() { return { url: `https://download.eclipse.org/jdtls/snapshots/jdt-language-server-${JDTLS}.tar.gz`, sha256: "02478201484f60a27fe5438899e98cc7bf56aaf380a856d1409eab14d228e153", format: "tar.gz" }; },
    entry: () => "plugins"
  }
];
