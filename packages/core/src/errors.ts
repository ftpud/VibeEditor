import type { ErrorCode } from "@remote-ide/protocol";

export class CoreError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "CoreError";
  }
}
