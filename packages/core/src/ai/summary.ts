import type { AiSession, AiStatus } from "@remote-ide/protocol";

export function summarizeAiSessions(sessions: AiSession[]): { status: AiStatus; preview: string; pendingPermission: boolean } {
  const active = sessions.find((session) => session.status === "in_progress" || session.status === "user_prompt");
  const latest = [...sessions].sort((left, right) => lastTimestamp(right).localeCompare(lastTimestamp(left)))[0];
  const session = active ?? latest;
  if (!session) return { status: "idle", preview: "", pendingPermission: false };
  const message = [...session.messages].reverse().find((item) => item.role === "assistant" || item.role === "activity") ?? session.messages.at(-1);
  return {
    status: session.status,
    preview: message?.text.replace(/\s+/g, " ").trim().slice(0, 180) ?? "",
    pendingPermission: sessions.some((item) => item.pendingPermission !== undefined)
  };
}

function lastTimestamp(session: AiSession): string {
  return session.messages.at(-1)?.timestamp ?? "";
}
