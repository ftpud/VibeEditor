import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiQuestionRequest } from "@remote-ide/protocol";
import { QuestionRequestForm } from "./QuestionRequestForm";

afterEach(cleanup);

const owner = { provider: "claude", taskId: "task-a", sessionId: "conversation-a" };
const request: AiQuestionRequest = { id: "q1", message: "Which database?", fields: [
  { id: "db", type: "choice", title: "Database", required: true, choices: [{ value: "pg", label: "Postgres", description: "Relational" }, { value: "redis", label: "Redis" }] },
  { id: "extras", type: "multi", title: "Extras", choices: [{ value: "cache", label: "Cache" }, { value: "queue", label: "Queue" }] },
  { id: "note", type: "text", title: "Note" },
  { id: "replicas", type: "integer", title: "Replicas" }
] };

describe("agent question form", () => {
  it("requires required fields and sends a typed answer without empty values", async () => {
    const onAnswer = vi.fn(async () => undefined);
    render(<QuestionRequestForm request={request} owner={owner} onAnswer={onAnswer} />);
    expect(screen.getByText("Which database?")).toBeTruthy();
    const answer = screen.getByRole("button", { name: "Answer" }) as HTMLButtonElement;
    expect(answer.disabled).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: /Postgres/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Queue" }));
    await userEvent.type(screen.getByRole("spinbutton", { name: "Replicas" }), "3");
    await userEvent.click(answer);
    expect(onAnswer).toHaveBeenCalledWith(owner, "q1", "accept", { db: "pg", extras: ["queue"], replicas: 3 });
  });

  it("can skip or cancel without an answer", async () => {
    const onAnswer = vi.fn(async () => undefined);
    render(<QuestionRequestForm request={request} owner={owner} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onAnswer).toHaveBeenCalledWith(owner, "q1", "decline", undefined);
  });
});
