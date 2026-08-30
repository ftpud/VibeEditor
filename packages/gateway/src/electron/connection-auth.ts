import type { ConnectConfig } from "ssh2";

export type AuthenticationMethod = "password" | "privateKey";
export type StoredConnectionAuth = { authenticationMethod?: AuthenticationMethod; password: string; privateKeyPath?: string; passphrase?: string };
export type ConnectionAuth = { authenticationMethod: "password"; password: string } | { authenticationMethod: "privateKey"; privateKeyPath: string; passphrase?: string };
export type ConnectionDetails = { host: string; port: number; username: string } & ConnectionAuth;

export function normalizeStoredAuthentication<T extends StoredConnectionAuth>(value: T): T & Required<Pick<StoredConnectionAuth, "authenticationMethod" | "password">> {
  return { ...value, authenticationMethod: value.authenticationMethod === "privateKey" ? "privateKey" : "password", password: value.password ?? "" };
}

export async function connectionConfig(connection: ConnectionDetails, readPrivateKey: (path: string) => Promise<Buffer>): Promise<ConnectConfig> {
  const base: ConnectConfig = { host: connection.host, port: connection.port, username: connection.username, readyTimeout: 20_000, keepaliveInterval: 10_000 };
  if (connection.authenticationMethod === "password") return { ...base, password: connection.password };
  if (!connection.privateKeyPath.trim()) throw new Error("A private key file is required for key authentication");
  let privateKey: Buffer;
  try { privateKey = await readPrivateKey(connection.privateKeyPath); }
  catch { throw new Error(`Could not read the private key file at ${connection.privateKeyPath}`); }
  return { ...base, privateKey, ...(connection.passphrase ? { passphrase: connection.passphrase } : {}) };
}

export async function testSshConnection(config: ConnectConfig, connect: (config: ConnectConfig) => Promise<{ end(): void }>): Promise<void> {
  const client = await connect(config);
  client.end();
}
