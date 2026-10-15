import type { Client } from "ssh2";

/** A lost SSH channel is an unknown outcome, not the remote command's output. */
export function executeSshCommand(client: Client, command: string, onOutput?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    const finish = (code?: number, interruption?: string) => {
      if (settled) return;
      settled = true;
      client.off("error", onError); client.off("close", onClose);
      const status = code ?? exitCode;
      if (status === 0) { resolve(stdout); return; }
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      if (status === undefined) reject(new Error(`SSH command interrupted: ${interruption ?? "channel closed without an exit status"}. The remote command may still be running or may have completed; reconnect and check its status before retrying.${output ? `\nLast remote output:\n${output.slice(-16000)}` : ""}`));
      else reject(new Error(`Remote command exited with ${status}${output ? `\n${output}` : ""}`));
    };
    const onError = (error: Error) => finish(undefined, error.message);
    const onClose = () => finish(undefined, "connection closed");
    client.once("error", onError); client.once("close", onClose);
    client.exec(command, (error, stream) => {
      if (error) { finish(undefined, error.message); return; }
      if (settled) { stream.close(); return; }
      const receive = (isError: boolean) => {
        let pending = "";
        return (data: Buffer) => {
          const text = data.toString();
          if (isError) stderr = (stderr + text).slice(-64000); else stdout = (stdout + text).slice(-4 * 1024 * 1024);
          pending += text;
          const lines = pending.split(/\r?\n/); pending = (lines.pop() ?? "").slice(-64000);
          for (const line of lines) onOutput?.(line);
        };
      };
      stream.on("data", receive(false)); stream.stderr.on("data", receive(true));
      stream.on("error", onError);
      stream.on("exit", (code: number | null) => { if (typeof code === "number") exitCode = code; });
      stream.on("close", (code?: number) => finish(code));
    });
  });
}
