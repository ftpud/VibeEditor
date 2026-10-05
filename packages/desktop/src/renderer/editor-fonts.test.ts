import type { Monaco } from "@monaco-editor/react";
import { expect, it, vi } from "vitest";
import { installEditorFontMeasurements } from "./editor-fonts";

it("waits for real font faces and remeasures later font loads without duplicate listeners", async () => {
  let resolve!: (faces: FontFace[]) => void;
  const pending = new Promise<FontFace[]>((done) => { resolve = done; });
  const load = vi.fn(() => pending);
  const fonts = Object.assign(new EventTarget(), { load }) as unknown as FontFaceSet;
  const remeasureFonts = vi.fn();
  const monaco = { editor: { remeasureFonts } } as unknown as Monaco;
  installEditorFontMeasurements(monaco, fonts);
  installEditorFontMeasurements(monaco, fonts);
  expect(load.mock.calls).toEqual([
    ['normal 13px "JetBrains Mono"'], ['bold 13px "JetBrains Mono"'],
    ['italic 13px "JetBrains Mono"'], ['bold italic 13px "JetBrains Mono"']
  ]);
  expect(remeasureFonts).not.toHaveBeenCalled();
  resolve([]);
  await vi.waitFor(() => expect(remeasureFonts).toHaveBeenCalledOnce());
  fonts.dispatchEvent(new Event("loadingdone"));
  expect(remeasureFonts).toHaveBeenCalledTimes(2);
});

it("still remeasures successful later loads if an initial font request failed", async () => {
  const load = vi.fn().mockRejectedValue(new Error("Font temporarily unavailable"));
  const fonts = Object.assign(new EventTarget(), { load }) as unknown as FontFaceSet;
  const remeasureFonts = vi.fn();
  installEditorFontMeasurements({ editor: { remeasureFonts } } as unknown as Monaco, fonts);
  await Promise.allSettled(load.mock.results.map((result) => result.value));
  expect(remeasureFonts).not.toHaveBeenCalled();
  fonts.dispatchEvent(new Event("loadingdone"));
  expect(remeasureFonts).toHaveBeenCalledOnce();
});
