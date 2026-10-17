import type { ComponentType } from "react";
import type { LanguageExtra } from "@remote-ide/protocol";
import type { CoreClient } from "../../client";
import { JavaConfigurationDialog } from "./java";
import { NpmConfigurationDialog } from "./node/NpmConfigurationDialog";

type Props = { language?: string; client: CoreClient; running: boolean; onClose(): void; onSaved(options: LanguageExtra): void };
export const projectConfigurationEditors: Record<string, ComponentType<Props>> = {
  node: NpmConfigurationDialog,
  java: ({ onSaved, ...props }) => <JavaConfigurationDialog {...props} onSaved={(options) => onSaved({ ...options })} />
};
