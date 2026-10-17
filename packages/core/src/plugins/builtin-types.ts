import type { ServerEvent } from "@remote-ide/protocol";
import type { WorkspaceFileSystem } from "../filesystem.js";
import type { LanguageDescriptor, LanguageService, LanguageServiceEvents } from "../language/service.js";
import type { ToolSpec } from "../tools.js";
import type { WorkspaceStateStore } from "../workspace-state.js";

/** What Core hands a built-in language when a root first uses it. */
export interface BuiltInLanguageHost {
  workspace: string;
  filesystem: WorkspaceFileSystem;
  state: WorkspaceStateStore;
  events: LanguageServiceEvents;
  rootId: string;
  /** Sends a protocol event to the connected client; for legacy per-language events only. */
  emit(event: ServerEvent): void;
}

/** A built-in language plugin: everything Core needs to register it, living in `plugins/languages/<id>/`. */
export interface BuiltInLanguage {
  descriptor: LanguageDescriptor;
  create(host: BuiltInLanguageHost): LanguageService;
  /** Tools to install on the Core host. */
  tools?: readonly ToolSpec[];
}
