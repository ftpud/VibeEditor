export type ProvisioningFailure = { retryable: boolean; repairable: boolean; message: string };

export function redactProvisioningLog(value: string): string {
  return value
    .replace(/(password|passphrase|token|authorization)\s*[:=]\s*[^\s]+/gi, "$1=[redacted]")
    .replace(/https:\/\/([^:\s/@]+):[^@\s]+@/g, "https://$1:[redacted]@");
}

export function boundedProvisioningLog(lines: string[], limit = 80): string[] {
  return lines.slice(-limit).map(redactProvisioningLog).map((line) => line.slice(0, 600));
}

export function classifyProvisioningFailure(error: unknown): ProvisioningFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancelled/i.test(message)) return { message: "Provisioning cancelled", retryable: true, repairable: false };
  if (/node-pty|npm (install|rebuild)|build|dist\//i.test(message)) return { message, retryable: true, repairable: true };
  if (/timed out|ECONNRESET|connection.*closed|SSH unavailable|not found/i.test(message)) return { message, retryable: true, repairable: false };
  return { message, retryable: false, repairable: false };
}
