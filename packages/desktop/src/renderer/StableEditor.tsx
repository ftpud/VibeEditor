import Editor, { type EditorProps, type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useCallback, useEffect, useRef } from "react";

type Props = Omit<EditorProps, "defaultValue" | "onChange" | "onMount" | "value"> & {
  value: string;
  onChange(value: string): void;
  onMount?: OnMount;
};

/**
 * Monaco owns its live model while the user types. Feeding every render back into
 * the controlled `value` prop can briefly apply stale text and move the cursor to
 * the end of the model. Only authoritative changes that did not originate in this
 * editor are synchronized back into Monaco.
 */
export function StableEditor({ value, onChange, onMount, ...props }: Props) {
  const instanceRef = useRef<editor.IStandaloneCodeEditor>();
  const localValueRef = useRef(value);
  const synchronizingRef = useRef(false);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance || value === localValueRef.current) return;
    localValueRef.current = value;
    if (instance.getValue() === value) return;
    const viewState = instance.saveViewState();
    synchronizingRef.current = true;
    instance.setValue(value);
    synchronizingRef.current = false;
    if (viewState) instance.restoreViewState(viewState);
  }, [value]);

  const mount = useCallback<OnMount>((instance, monaco) => {
    instanceRef.current = instance;
    if (instance.getValue() !== value) instance.setValue(value);
    localValueRef.current = value;
    onMount?.(instance, monaco);
  }, [onMount, value]);

  return <Editor
    {...props}
    defaultValue={value}
    onMount={mount}
    onChange={(next) => {
      if (synchronizingRef.current) return;
      const content = next ?? "";
      localValueRef.current = content;
      onChange(content);
    }}
  />;
}
