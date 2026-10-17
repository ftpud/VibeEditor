import type { JavaDebugVariable, LanguageDebugVariable, RunConfig, ServerEvent } from "./index.js";

type Validator = (value: unknown) => boolean;
type Schema<T> = { [K in keyof T]-?: Validator };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const string: Validator = (value) => typeof value === "string";
const boolean: Validator = (value) => typeof value === "boolean";
const number: Validator = (value) => typeof value === "number" && Number.isFinite(value);
const optional = (validate: Validator): Validator => (value) => value === undefined || validate(value);
const nullable = (validate: Validator): Validator => (value) => value === null || validate(value);
const array = (validate: Validator): Validator => (value) => Array.isArray(value) && value.every(validate);
const choice = (...values: string[]): Validator => (value) => typeof value === "string" && values.includes(value);
const shape = <T>(schema: Schema<T>): Validator => (value) => object(value) && Object.entries(schema).every(([key, validate]) => (validate as Validator)(value[key]));

const runConfig = shape<RunConfig>({
  scope: choice("global", "local"), name: string, commands: string,
  status: choice("idle", "starting", "running", "stopping", "succeeded", "failed"),
  terminalId: optional(string), exitCode: optional(number)
});
const variable = shape<JavaDebugVariable>({
  name: string, value: string, reference: optional(string), type: optional(string),
  objectId: optional(string), indexedCount: optional(number)
});

const languageVariable = shape<LanguageDebugVariable>({
  name: string, value: string, reference: optional(string), type: optional(string),
  indexedCount: optional(number), extra: optional(object)
});

// Both event names and every payload field must be accounted for when Protocol changes.
const eventPayloadSchemas = {
  "processes.changed": {},
  "configuration.changed": { rootId: string, resource: string, global: boolean },
  "timers.changed": { rootId: optional(string) },
  "workflow.document": { rootId: string, runId: string, blockId: string, title: string, content: string },
  "filesystem.changed": { rootId: string, paths: array(string), overflow: boolean, health: choice("healthy", "degraded"), message: optional(string) },
  "terminal.opened": { rootId: string, workspace: string, session: shape({ terminalId: string, status: choice("running", "exited"), output: string, exitCode: optional(number), displayName: optional(string) }) },
  "terminal.output": { rootId: string, terminalId: string, data: string },
  "terminal.exit": { rootId: string, terminalId: string, exitCode: number },
  "git.changed": { rootId: string },
  "taskGit.changed": { rootId: string },
  "language.semantic.changed": { rootId: string, language: string },
  "language.output": { rootId: string, language: string, data: string, stream: choice("stdout", "stderr") },
  "language.exit": { rootId: string, language: string, exitCode: nullable(number), signal: optional(nullable(string)) },
  "language.debug.state": {
    rootId: string, language: string, status: choice("starting", "running", "paused", "stopped"), variables: array(languageVariable),
    path: optional(string), line: optional(number), frame: optional(string), stopReason: optional(string),
    inspectionError: optional(string), busy: optional(boolean), extra: optional(object)
  },
  "java.semantic.changed": { rootId: string },
  "java.output": { rootId: string, data: string },
  "java.exit": { rootId: string, exitCode: nullable(number), signal: nullable(string) },
  "java.debug.state": {
    rootId: string, status: choice("starting", "running", "paused", "stopped"), variables: array(variable),
    path: optional(string), className: optional(string), method: optional(string), line: optional(number),
    applyingChanges: optional(boolean), inspectionError: optional(string), stopReason: optional(string)
  },
  "ai.changed": { rootId: string },
  "tasks.changed": { rootId: string },
  "commit-message.changed": { rootId: string, workspace: optional(string), message: string },
  "runConfig.changed": { rootId: string, configs: array(runConfig) },
  "harness.changed": { rootId: string, runId: string }
} satisfies { [K in ServerEvent["type"]]: Schema<Extract<ServerEvent, { type: K }>["payload"]> };

export const serverEventTypes = Object.freeze(Object.keys(eventPayloadSchemas) as ServerEvent["type"][]);

/** Validate wire shape, allowing extra fields for compatible evolution; never change payloads. */
export function isServerEvent(value: unknown): value is ServerEvent {
  if (!object(value) || typeof value.type !== "string" || "id" in value || "ok" in value || !object(value.payload)) return false;
  if (!Object.hasOwn(eventPayloadSchemas, value.type)) return false;
  const schema = eventPayloadSchemas[value.type as ServerEvent["type"]];
  const payload = value.payload;
  return Object.entries(schema).every(([key, validate]) => validate(payload[key]));
}
