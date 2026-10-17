import type { WorkspaceFileSystem } from "../../../filesystem.js";
import type { BuiltInLanguage } from "../../builtin-types.js";
import { JAVA_DESCRIPTOR, JavaLanguageService, type JavaLegacyEvents } from "./service.js";
import { JAVA_TOOLS } from "./tools.js";

export { JAVA_DESCRIPTOR, JavaLanguageService, type JavaLegacyEvents };

/** The Java language plugin: service, host tools (JRE, JDT LS) . */
export const javaLanguage: BuiltInLanguage = {
  descriptor: JAVA_DESCRIPTOR,
  tools: JAVA_TOOLS,
  create: ({ filesystem, state, events, rootId, emit }) => new JavaLanguageService(filesystem as WorkspaceFileSystem, state, events, undefined, {
    // Debug state is the only legacy java.* event Desktop still consumes: it needs Java's class and method fields.
    process: (event) => { if (event.type === "debug") emit({ type: "java.debug.state", payload: { ...event.state, rootId } }); },
    semanticChanged: () => undefined
  })
};
