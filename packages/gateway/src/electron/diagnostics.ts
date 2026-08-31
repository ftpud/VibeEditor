export type DiagnosticRuntime = { status: string; message: string; updatedAt?: string; stage?: string; latencyMs?: number; logs?: string[] };
export type DiagnosticWorkspace = { id: string; name: string; remotePort: number };
export type DiagnosticTunnel = { id: string; port: number };

const MAX_MESSAGE = 500;
const MAX_LOG_LINES = 40;
const MAX_LOG_LINE = 500;

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, "[private key redacted]")
    .replace(/\b(password|passphrase|token|authorization|api[_-]?key|secret|private[_-]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 [redacted]")
    .replace(/(https?:\/\/[^\s/:@]+:)[^@\s]+@/gi, "$1[redacted]@")
    .replace(/\b(?:[A-Z][A-Z0-9_]{2,})=(?:"[^"]*"|'[^']*'|[^\s]+)/g, (match) => `${match.slice(0, match.indexOf("=") + 1)}[redacted]`);
}

function clean(value: string, limit = MAX_MESSAGE): string {
  return redactDiagnosticText(value).replace(/[\r\n]+/g, " ").slice(0, limit);
}

function runtimeLines(label: string, runtime: DiagnosticRuntime | undefined): string[] {
  if (!runtime) return [`${label}: state=unknown stage=unknown updated=unknown`];
  const latency = runtime.latencyMs === undefined ? "" : ` latency=${runtime.latencyMs}ms`;
  return [
    `${label}: state=${clean(runtime.status, 60)} stage=${clean(runtime.stage ?? runtime.status, 80)} updated=${runtime.updatedAt ?? "unknown"}${latency}`,
    `  message: ${clean(runtime.message)}`,
  ];
}

export function buildConnectionDiagnostics(input: {
  generatedAt: string;
  version: string;
  platform: string;
  connection: { name: string; authenticationMethod: string };
  connectionRuntime?: DiagnosticRuntime;
  workspaces: DiagnosticWorkspace[];
  runtimes: Record<string, DiagnosticRuntime>;
  tunnels: DiagnosticTunnel[];
  tunnelRuntimes: Record<string, DiagnosticRuntime>;
}): string {
  const lines = [
    "Vibe Gateway connection diagnostics",
    `generated=${input.generatedAt}`,
    `version=${clean(input.version, 80)} platform=${clean(input.platform, 80)}`,
    `connection=${clean(input.connection.name, 120)} authentication=${clean(input.connection.authenticationMethod, 40)}`,
    ...runtimeLines("ssh", input.connectionRuntime),
  ];
  for (const workspace of input.workspaces) {
    const current = input.runtimes[workspace.id];
    lines.push("", ...runtimeLines(`workspace ${clean(workspace.name, 120)} core-port=${workspace.remotePort}`, current));
    const tail = (current?.logs ?? []).slice(-MAX_LOG_LINES);
    if (tail.length) {
      lines.push(`  provisioning-log-tail (${tail.length}/${MAX_LOG_LINES} max):`);
      lines.push(...tail.map((line) => `    ${clean(line, MAX_LOG_LINE)}`));
    }
  }
  for (const tunnel of input.tunnels) lines.push("", ...runtimeLines(`tunnel localhost:${tunnel.port}`, input.tunnelRuntimes[tunnel.id]));
  return `${lines.join("\n")}\n`;
}
