import type { AiProvider } from "@remote-ide/protocol";
import { readSetting, workspaceSettingKey, writeSetting } from "./settings";

/** A renderer-owned draft is deliberately scoped to its task and conversation. */
export function aiPromptDraftKey(workspace: string, taskId: string | undefined, provider: AiProvider, sessionId: string | undefined): string {
  return workspaceSettingKey(workspace, `ai.promptDraft.${encodeURIComponent(taskId ?? "root")}.${encodeURIComponent(provider)}.${encodeURIComponent(sessionId ?? "new")}`);
}

export function readAiPromptDraft(workspace: string, taskId: string | undefined, provider: AiProvider, sessionId: string | undefined): string {
  return readSetting(aiPromptDraftKey(workspace, taskId, provider, sessionId)) ?? "";
}

export function writeAiPromptDraft(workspace: string, taskId: string | undefined, provider: AiProvider, sessionId: string | undefined, draft: string): void {
  writeSetting(aiPromptDraftKey(workspace, taskId, provider, sessionId), draft);
}
