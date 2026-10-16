import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { spawn as spawnPty, type IPty } from "node-pty";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type AuthMethod, type Client, type CreateElicitationResponse } from "@agentclientprotocol/sdk";
import type { AiAuthentication, AiAuthInput } from "@remote-ide/acp";
import { managedProcesses } from "../managed-processes.js";

/** `unsetEnv` names variables removed from the inherited environment (for example API keys the user chose not to use). */
export type Launch = { command: string; args: string[]; env?: NodeJS.ProcessEnv; unsetEnv?: string[] };
export function withoutEnv(env: NodeJS.ProcessEnv, names: readonly string[] = []): NodeJS.ProcessEnv {
  if (!names.length) return env;
  const result = { ...env };
  for (const name of names) delete result[name];
  return result;
}
type Flow = { identity: string; state: AiAuthentication; methods: AuthMethod[]; child?: ChildProcessWithoutNullStreams; terminal?: IPty; connection?: ClientSideConnection; answer?: (response: CreateElicitationResponse) => void; timer?: ReturnType<typeof setTimeout> };
const capabilities = { auth: { terminal: true }, elicitation: { url: {} } };
/** ACP reserves -32000 for `auth_required`; some agents only describe it in the message. */
export function isAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : String(error);
  return (error as { code?: number })?.code === -32000 || /authentication required|auth_required|not authenticated|not logged in|unauthori[sz]ed|please (?:log|sign) ?in/i.test(message);
}
const displayMethods = (methods: AuthMethod[]) => methods.map(method => ({ id: method.id, name: method.name, ...(method.description ? { description: method.description } : {}), type: "type" in method && method.type === "terminal" ? "terminal" as const : "agent" as const }));

/** Account setup is live provider state, never conversation history or configuration. */
export class AcpAuthentication {
  private readonly flows = new Map<string, Flow>();
  private readonly discoveries = new Map<string, Promise<void>>();
  private readonly cleanups = new Map<Flow, Promise<void>>();
  private closed = false;
  constructor(private readonly provider: string, private readonly launch: () => Promise<Launch>) {}

  observe(workspace: string, methods: AuthMethod[], status?: "required" | "authenticated"): void {
    const flow = this.flow(workspace);
    if (flow.state.status === "authenticating") return;
    flow.methods = methods;
    flow.state = { status: status ?? flow.state.status, methods: displayMethods(methods) };
  }
  private flow(workspace: string): Flow {
    let flow = this.flows.get(workspace);
    if (!flow) { flow = { identity: crypto.randomUUID(), state: { status: "unknown", methods: [] }, methods: [] }; this.flows.set(workspace, flow); }
    return flow;
  }
  async get(workspace: string, discover = false): Promise<AiAuthentication> {
    if (this.closed) throw new Error("Core is shutting down");
    const flow = this.flow(workspace);
    if (discover) await this.cleanups.get(flow);
    if (this.closed) throw new Error("Core is shutting down");
    if (discover && flow.state.status !== "authenticating") {
      let pending = this.discoveries.get(workspace);
      if (!pending) {
        // Discovery is also the account check: a session opens only when signed in.
        pending = (async () => {
          const launch = await this.launch();
          try { await this.verify(workspace, flow, await this.open(workspace, flow, launch)); }
          finally { await this.stop(flow); }
        })();
        this.discoveries.set(workspace, pending);
      }
      try { await pending; }
      finally { if (this.discoveries.get(workspace) === pending) this.discoveries.delete(workspace); }
    }
    return { ...flow.state };
  }
  async start(workspace: string, methodId: string): Promise<AiAuthentication> {
    if (typeof methodId !== "string" || !methodId || methodId.length > 500) throw new Error("Invalid ACP authentication method");
    if (this.closed) throw new Error("Core is shutting down");
    await this.discoveries.get(workspace);
    if (this.closed) throw new Error("Core is shutting down");
    const flow = this.flow(workspace);
    await this.cleanups.get(flow);
    if (this.closed) throw new Error("Core is shutting down");
    if (flow.state.status === "authenticating") return { ...flow.state };
    const requestId = crypto.randomUUID();
    flow.state = { status: "authenticating", requestId, methodId, methods: displayMethods(flow.methods), output: "" };
    // Return immediately: browser/device-code/terminal sign-in waits for a person.
    void this.run(workspace, flow, methodId).catch(async error => {
      if (flow.state.requestId !== requestId || flow.state.status !== "authenticating") return;
      flow.state = { ...flow.state, status: "error", awaitingConfirmation: false, error: error instanceof Error ? error.message : String(error) };
      await this.stop(flow);
    });
    flow.timer = setTimeout(() => { void this.input(workspace, { requestId, action: "cancel" }).catch(() => {}); }, 10 * 60_000);
    flow.timer.unref();
    return { ...flow.state };
  }
  async input(workspace: string, input: AiAuthInput): Promise<AiAuthentication> {
    const flow = this.flow(workspace);
    if (!input || input.requestId !== flow.state.requestId || flow.state.status !== "authenticating") throw new Error("This sign-in request is no longer active");
    if (input.action === "cancel") {
      flow.state = { status: "required", methods: flow.state.methods };
      await this.stop(flow);
      return { ...flow.state };
    }
    if (input.action === "accept") { flow.answer?.({ action: "accept" }); flow.answer = undefined; flow.state.awaitingConfirmation = false; }
    if (input.data !== undefined) {
      if (typeof input.data !== "string" || input.data.length > 10000 || !flow.terminal) throw new Error("Sign-in terminal input is unavailable or invalid");
      flow.terminal.write(input.data);
    }
    if (input.cols !== undefined || input.rows !== undefined) {
      if (!Number.isInteger(input.cols) || !Number.isInteger(input.rows) || input.cols! < 10 || input.cols! > 500 || input.rows! < 2 || input.rows! > 200) throw new Error("Invalid sign-in terminal size");
      flow.terminal?.resize(input.cols!, input.rows!);
    }
    return { ...flow.state };
  }
  async shutdown(): Promise<void> { this.closed = true; await Promise.all([...this.flows.values()].map(flow => this.stop(flow))); this.flows.clear(); }

  private append(flow: Flow, output: string): void { if (flow.state.status === "authenticating") flow.state.output = ((flow.state.output ?? "") + output).slice(-20000); }
  private async open(workspace: string, flow: Flow, launch: Launch): Promise<ClientSideConnection> {
    if (this.closed) throw new Error("Core is shutting down");
    const child = managedProcesses.launch({ workspace, rootWorkspace: workspace, provider: this.provider, sessionId: flow.identity, kind: "agent" }, env => spawn(launch.command, launch.args, { cwd: workspace, env: withoutEnv({ ...env, ...launch.env }, launch.unsetEnv), stdio: "pipe" }));
    flow.child = child;
    const failed = new Promise<never>((_resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`Authentication agent exited (${signal ?? code})`)));
    });
    // A rejection may arrive after initialize finishes; the RPC transport owns later failures.
    void failed.catch(() => {});
    child.stderr.on("data", chunk => this.append(flow, String(chunk)));
    const client: Client = {
      requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
      sessionUpdate: () => {},
      createElicitation: params => {
        if (params.mode !== "url" || typeof params.url !== "string") return { action: "cancel" };
        let url: URL;
        try { url = new URL(params.url); } catch { return { action: "cancel" }; }
        if (!["https:", "http:"].includes(url.protocol)) return { action: "cancel" };
        flow.state.url = url.toString(); flow.state.message = params.message; flow.state.awaitingConfirmation = true;
        return new Promise<CreateElicitationResponse>(resolve => { flow.answer = resolve; });
      }
    };
    const connection = new ClientSideConnection(() => client, ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
    flow.connection = connection;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const initialized = await Promise.race([connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: capabilities, clientInfo: { name: "Vibe Editor", version: "0.1.0" } }), failed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Authentication agent initialization timed out")), 30000); })]);
      flow.methods = initialized.authMethods ?? [];
      flow.state.methods = displayMethods(flow.methods);
      return connection;
    } finally { clearTimeout(timer); }
  }
  private async verify(workspace: string, flow: Flow, connection: ClientSideConnection): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([connection.newSession({ cwd: workspace, mcpServers: [] }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("The agent did not open a session within 60 seconds")), 60_000); })]);
      if (flow.state.status !== "authenticating") flow.state = { status: "authenticated", methods: flow.state.methods };
    } catch (error) {
      if (flow.state.status === "authenticating") return;
      flow.state = isAuthenticationError(error) ? { status: "required", methods: flow.state.methods } : { status: "error", methods: flow.state.methods, error: `Could not verify the account: ${error instanceof Error ? error.message : (error as { message?: string })?.message ?? String(error)}` };
    } finally { clearTimeout(timer); }
  }
  private async run(workspace: string, flow: Flow, methodId: string): Promise<void> {
    const requestId = flow.state.requestId;
    const launch = await this.launch();
    if (flow.state.status !== "authenticating" || flow.state.requestId !== requestId) return;
    const connection = await this.open(workspace, flow, launch);
    if (flow.state.status !== "authenticating" || flow.state.requestId !== requestId) return;
    const method = flow.methods.find(method => method.id === methodId);
    if (!method) throw new Error("The agent did not advertise this authentication method");
    if ("type" in method && method.type === "terminal") {
      flow.child?.kill(); flow.child = undefined; flow.connection = undefined;
      flow.state.terminal = true;
      const context = { workspace, rootWorkspace: workspace, provider: this.provider, sessionId: flow.identity, kind: "agent" as const };
      const identity = managedProcesses.prepare(context);
      try {
        const terminal = spawnPty(launch.command, [...launch.args, ...method.args ?? []], { cwd: workspace, env: withoutEnv({ ...identity.env, ...launch.env, ...method.env }, launch.unsetEnv), name: "xterm-256color", cols: 90, rows: 18 });
        flow.terminal = terminal;
        const lifecycle = Object.assign(new EventEmitter(), { pid: terminal.pid });
        managedProcesses.track(lifecycle, context, identity.launchId);
        terminal.onData(data => this.append(flow, data));
        await new Promise<void>((resolve, reject) => terminal.onExit(({ exitCode }) => { lifecycle.emit("exit"); flow.terminal = undefined; exitCode === 0 ? resolve() : reject(new Error(`Sign-in exited with code ${exitCode}`)); }));
      } catch (error) { managedProcesses.abandon(identity.launchId); throw error; }
      if (flow.state.status !== "authenticating" || flow.state.requestId !== requestId) return;
      const verified = await this.open(workspace, flow, launch);
      if (flow.state.status !== "authenticating" || flow.state.requestId !== requestId) return;
      await verified.newSession({ cwd: workspace, mcpServers: [] });
    } else {
      await connection.authenticate({ methodId });
    }
    if (flow.state.status !== "authenticating" || flow.state.requestId !== requestId) return;
    flow.state = { status: "authenticated", methods: flow.state.methods };
    await this.stop(flow);
  }
  private stop(flow: Flow): Promise<void> {
    const pending = this.cleanups.get(flow);
    if (pending) return pending;
    const cleanup = this.stopProcesses(flow).finally(() => { if (this.cleanups.get(flow) === cleanup) this.cleanups.delete(flow); });
    this.cleanups.set(flow, cleanup);
    return cleanup;
  }
  private async stopProcesses(flow: Flow): Promise<void> {
    clearTimeout(flow.timer);
    flow.answer?.({ action: "cancel" }); flow.answer = undefined;
    flow.child?.kill("SIGTERM"); flow.child = undefined;
    flow.terminal?.kill(); flow.terminal = undefined;
    flow.connection = undefined;
    const children = await managedProcesses.list().catch(() => []);
    await Promise.all(children.filter(child => child.sessionId === flow.identity).map(child => managedProcesses.kill(child.id, context => Promise.resolve(context.sessionId === flow.identity)).catch(() => false)));
  }
}
