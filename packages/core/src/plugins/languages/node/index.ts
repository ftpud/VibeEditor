import type { BuiltInLanguage } from "../../builtin-types.js";
import { NODE_DESCRIPTOR, NodeLanguageService } from "./service.js";

export { NODE_DESCRIPTOR, NodeLanguageService };

export const nodeLanguage: BuiltInLanguage = {
  descriptor: NODE_DESCRIPTOR,
  create: ({ workspace, events, filesystem }) => new NodeLanguageService(workspace, events, filesystem)
};
