import { describe, expect, it } from "vitest";
import { remoteTransferDefaultLimit, requestTypes } from "@remote-ide/protocol";

describe("remote transfer protocol contract", () => { it("advertises control operations and a finite default limit", () => { expect(requestTypes).toContain("filesystem.remoteTransferBegin"); expect(requestTypes).toContain("filesystem.remoteTransferCancel"); expect(remoteTransferDefaultLimit).toBe(512 * 1024 * 1024); }); });
