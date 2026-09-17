import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let editorProps: Record<string, unknown> = {};
vi.mock("@monaco-editor/react", () => ({ default: (props: Record<string, unknown>) => { editorProps = props; return null; } }));

import { StableEditor } from "./StableEditor";

afterEach(cleanup);

describe("StableEditor", () => {
  it("does not feed a stale parent value back into Monaco after local typing", () => {
    let content = "start";
    const setValue = vi.fn((value: string) => { content = value; });
    const instance = { getValue: () => content, setValue, saveViewState: vi.fn(() => ({ cursorState: [] })), restoreViewState: vi.fn() };
    const onChange = vi.fn();
    const view = render(<StableEditor value="start" onChange={onChange} />);
    act(() => (editorProps.onMount as (editor: typeof instance, monaco: unknown) => void)(instance, {}));
    act(() => { content = "start!"; (editorProps.onChange as (value: string) => void)(content); });
    view.rerender(<StableEditor value="start" onChange={onChange} />);
    expect(setValue).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith("start!");
  });

  it("applies authoritative external content while restoring the view state", () => {
    let content = "start";
    const viewState = { cursorState: [] };
    const instance = { getValue: () => content, setValue: vi.fn((value: string) => { content = value; }), saveViewState: vi.fn(() => viewState), restoreViewState: vi.fn() };
    const view = render(<StableEditor value="start" onChange={vi.fn()} />);
    act(() => (editorProps.onMount as (editor: typeof instance, monaco: unknown) => void)(instance, {}));
    view.rerender(<StableEditor value="external" onChange={vi.fn()} />);
    expect(instance.setValue).toHaveBeenCalledWith("external");
    expect(instance.restoreViewState).toHaveBeenCalledWith(viewState);
  });
});
