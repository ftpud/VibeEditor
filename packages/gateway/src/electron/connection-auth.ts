import ssh2 from "ssh2";
import type { ConnectConfig } from "ssh2";

export type AuthenticationMethod = "password" | "privateKey" | "agent";
export type StoredConnectionAuth = { authenticationMethod?: AuthenticationMethod; password: string; privateKeyPath?: string; passphrase?: string };
export type ConnectionAuth = { authenticationMethod: "password"; password: string } | { authenticationMethod: "privateKey"; privateKeyPath: string; passphrase?: string } | { authenticationMethod: "agent" };
export type ConnectionDetails = { host: string; port: number; username: string; hostKeyFingerprint?: string } & ConnectionAuth;

export function normalizeStoredAuthentication<T extends StoredConnectionAuth>(value: T): T & Required<Pick<StoredConnectionAuth, "authenticationMethod" | "password">> {
  return { ...value, authenticationMethod: value.authenticationMethod === "privateKey" || value.authenticationMethod === "agent" ? value.authenticationMethod : "password", password: value.password ?? "" };
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
  if (/host denied|host key verification failed/i.test(message)) return new Error("The SSH server host key does not match the fingerprint you trusted. This can indicate a server rebuild or a security risk; edit the connection and test it before trusting the new fingerprint.");
  if (method === "privateKey" && /all configured authentication methods failed|authentication failed/i.test(message)) {
    return new Error("The SSH server rejected this private key. Confirm its matching public key is in the remote user's ~/.ssh/authorized_keys and that the username is correct.");
  }
  if (method === "agent" && /all configured authentication methods failed|authentication failed/i.test(message)) {
    return new Error("The SSH agent did not offer a key accepted by this server. Add the matching key to your OS SSH agent and confirm its public key is in ~/.ssh/authorized_keys.");
  }
  return new Error(message);
}

export function formatHostFingerprint(hash: string): string { return `SHA256:${hash.replace(/^SHA256:/, "")}`; }

export function hostKeyVerifier(expected: string | undefined, observed: (fingerprint: string) => void): (hash: string) => boolean {
  return (hash) => {
    const fingerprint = formatHostFingerprint(hash);
    observed(fingerprint);
    return !expected || fingerprint === formatHostFingerprint(expected);
  };
}

export async function connectionConfig(connection: ConnectionDetails, readPrivateKey: (path: string) => Promise<Buffer>, observedHostKey: (fingerprint: string) => void = () => {}): Promise<ConnectConfig> {
  const agent = process.env.SSH_AUTH_SOCK;
  const base: ConnectConfig = { host: connection.host, port: connection.port, username: connection.username, readyTimeout: 20_000, keepaliveInterval: 10_000 };
  base.hostHash = "sha256";
  base.hostVerifier = hostKeyVerifier(connection.hostKeyFingerprint, observedHostKey);
  if (connection.authenticationMethod === "password") return { ...base, password: connection.password };
  if (connection.authenticationMethod === "agent") {
    if (!agent) throw new Error("SSH-agent authentication is unavailable because SSH_AUTH_SOCK is not set. Start your OS SSH agent and add a key, or choose another authentication method.");
    return { ...base, agent };
  }
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
