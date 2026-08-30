import ssh2 from "ssh2";
import type { ConnectConfig } from "ssh2";

export type AuthenticationMethod = "password" | "privateKey";
export type StoredConnectionAuth = { authenticationMethod?: AuthenticationMethod; password: string; privateKeyPath?: string; passphrase?: string };
export type ConnectionAuth = { authenticationMethod: "password"; password: string } | { authenticationMethod: "privateKey"; privateKeyPath: string; passphrase?: string };
export type ConnectionDetails = { host: string; port: number; username: string } & ConnectionAuth;

export function normalizeStoredAuthentication<T extends StoredConnectionAuth>(value: T): T & Required<Pick<StoredConnectionAuth, "authenticationMethod" | "password">> {
  return { ...value, authenticationMethod: value.authenticationMethod === "privateKey" ? "privateKey" : "password", password: value.password ?? "" };
}

/** Validate locally so ssh2 does not turn an invalid key into a generic auth failure. */
export function validatePrivateKey(privateKey: Buffer, passphrase?: string): void {
  const text = privateKey.toString("utf8").trim();
  if (/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-)/.test(text)) {
    throw new Error("This is an SSH public key (.pub), not a private key. Choose the matching private key file (for example ~/.ssh/id_ed25519).");
  }
  const parsed = ssh2.utils.parseKey(privateKey, passphrase);
  if (!(parsed instanceof Error)) return;
  const message = parsed.message.toLowerCase();
  if (!passphrase && (message.includes("encrypted") || text.includes("bcrypt"))) {
    throw new Error("This private key is encrypted and requires its passphrase.");
  }
  if (passphrase && (message.includes("passphrase") || message.includes("integrity") || message.includes("decrypt"))) {
    throw new Error("The private-key passphrase is incorrect, or this key format is unsupported.");
  }
  throw new Error("The selected file is not a supported SSH private key. Choose an RSA, ECDSA, Ed25519, or OpenSSH private key file.");
}

export function validatePrivateKeyPath(privateKeyPath: string): void {
  if (/\.pub$/i.test(privateKeyPath.trim())) {
    throw new Error("This is a public-key (.pub) file. Choose the matching private key file instead (for example ~/.ssh/id_ed25519).");
  }
}

export function sshConnectionError(error: unknown, method: AuthenticationMethod): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (method === "privateKey" && /all configured authentication methods failed|authentication failed/i.test(message)) {
    return new Error("The SSH server rejected this private key. Confirm its matching public key is in the remote user's ~/.ssh/authorized_keys and that the username is correct.");
  }
  return new Error(message);
}

export async function connectionConfig(connection: ConnectionDetails, readPrivateKey: (path: string) => Promise<Buffer>): Promise<ConnectConfig> {
  const base: ConnectConfig = { host: connection.host, port: connection.port, username: connection.username, readyTimeout: 20_000, keepaliveInterval: 10_000 };
  if (connection.authenticationMethod === "password") return { ...base, password: connection.password };
  if (!connection.privateKeyPath.trim()) throw new Error("A private key file is required for key authentication");
  validatePrivateKeyPath(connection.privateKeyPath);
  let privateKey: Buffer;
  try { privateKey = await readPrivateKey(connection.privateKeyPath); }
  catch { throw new Error(`Could not read the private key file at ${connection.privateKeyPath}`); }
  validatePrivateKey(privateKey, connection.passphrase);
  return { ...base, privateKey, ...(connection.passphrase ? { passphrase: connection.passphrase } : {}) };
}

export async function testSshConnection(config: ConnectConfig, connect: (config: ConnectConfig) => Promise<{ end(): void }>): Promise<void> {
  const client = await connect(config);
  client.end();
}
