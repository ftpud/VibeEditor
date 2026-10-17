import { createProvider as createCodexProvider } from "./ai/codex/index.js";
import { createProvider as createCopilotProvider } from "./ai/copilot/index.js";
import { createProvider as createClaudeProvider } from "./ai/claude/index.js";
import type { ProviderFactory } from "../ai/stdio-provider.js";

import { registerTools } from "../tools.js";
import type { BuiltInLanguage } from "./builtin-types.js";
import { javaLanguage } from "./languages/java/index.js";
import { nodeLanguage } from "./languages/node/index.js";

/**
 * The only module shared Core imports to reach built-in plugins. Each plugin
 * lives in its own directory (`plugins/ai/<id>`, `plugins/languages/<id>`);
 * adding one means adding it here, never editing shared Core code.
 */
export const BUILT_IN_LANGUAGES: readonly BuiltInLanguage[] = [javaLanguage, nodeLanguage];

for (const language of BUILT_IN_LANGUAGES) if (language.tools) registerTools(language.tools);

export { JAVA_DESCRIPTOR, JavaLanguageService } from "./languages/java/index.js";
export type { BuiltInLanguage, BuiltInLanguageHost } from "./builtin-types.js";

/** All built-in AI adapters use the same factory contract as external providers. */
export const BUILT_IN_PROVIDERS: ProviderFactory[] = [createCodexProvider, createCopilotProvider, createClaudeProvider];
export { CodexSessionManager } from "./ai/codex/index.js";
export { CopilotSessionManager } from "./ai/copilot/index.js";
export { ClaudeSessionManager } from "./ai/claude/index.js";
