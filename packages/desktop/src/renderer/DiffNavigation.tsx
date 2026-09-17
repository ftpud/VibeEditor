import type { editor } from "monaco-editor";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { RefObject } from "react";

type DiffNavigator = Pick<editor.IStandaloneDiffEditor, "goToDiff">;

export function DiffNavigation({ editorRef }: { editorRef: RefObject<DiffNavigator | undefined> }) {
  return <div className="diff-navigation" aria-label="Diff navigation">
    <button type="button" title="Previous difference" aria-label="Previous difference" onClick={() => editorRef.current?.goToDiff("previous")}><ChevronUp size={16} /></button>
    <button type="button" title="Next difference" aria-label="Next difference" onClick={() => editorRef.current?.goToDiff("next")}><ChevronDown size={16} /></button>
  </div>;
}
