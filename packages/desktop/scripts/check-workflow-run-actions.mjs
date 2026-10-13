// Browser layout regression, run from any directory after npm install.
// Requires Playwright + Chromium. An external Playwright module and an optional
// stylesheet override can be supplied without adding dependencies to this repo:
// node packages/desktop/scripts/check-workflow-run-actions.mjs /path/to/playwright/index.mjs [styles.css]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { chromium } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : "playwright");
const styles = readFileSync(process.argv[3] ?? new URL("../src/renderer/styles.css", import.meta.url), "utf8");
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { WorkflowRunPanel } from "./packages/desktop/src/renderer/WorkflowRunPanel";
import { HarnessPanel } from "./packages/desktop/src/renderer/HarnessPanel";
window.mount = (component, count) => {
  const definition = { id: "flow", name: "Layout check", version: 1, createdAt: "now", updatedAt: "now",
    blocks: [{ id: "work", type: "ai", label: "Work", prompt: "Check", position: { x: 0, y: 0 } }], edges: [] };
  const completed = { id: "completed", harnessId: "flow", harnessVersion: 1, definition, input: "Saved prompt",
    status: "succeeded", createdAt: "2026-10-01T12:00:00Z", blocks: [] };
  const runs = [completed, ...Array.from({ length: count }, (_, index) => ({ ...completed,
    id: "active-" + index, status: "running", createdAt: "2026-10-02T12:00:00Z" }))];
  window.cancelled = [];
  window.failCancellation = false;
  const props = { harnesses: [definition], runs, onRun: async () => completed, onError: () => {},
    onCancelRun: async (id) => { window.cancelled.push(id); if (window.failCancellation) throw Error("Cancellation failed"); } };
  createRoot(document.getElementById("root")).render(component === "card" ? <WorkflowRunPanel {...props} /> :
    <HarnessPanel {...props} providers={[]} agents={[]} onCreate={async () => definition}
      onSave={async () => definition} onDelete={async () => {}} />);
};`;
const bundle = await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root, sourcefile: "workflow-actions-fixture.tsx" }, bundle: true, write: false, jsx: "automatic", format: "iife" });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  for (const component of ["card", "harness"]) {
    for (const theme of ["dark", "light"]) {
      for (const width of [240, 320, 800]) {
        for (const count of [1, 6, 0]) {
          await page.goto("about:blank");
          await page.setContent(`<html data-theme="${theme}"><style>${styles}</style><div id="root" style="width:${width}px;height:900px"></div></html>`);
          await page.addScriptTag({ content: bundle.outputFiles[0].text });
          await page.evaluate(({ component, count }) => window.mount(component, count), { component, count });
          if (component === "card") {
            await page.getByRole("button", { name: "Show Layout check", exact: true }).click();
            await page.getByRole("combobox", { name: "Run for Layout check" }).selectOption("completed");
          } else {
            await page.getByRole("combobox", { name: "Selected workflow run" }).selectOption("completed");
          }
          const toolbar = page.locator(component === "card" ? ".workflow-run-controls" : ".harness-run-actions");
          const measurements = await toolbar.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const parent = element.parentElement.getBoundingClientRect();
            const buttons = [...element.querySelectorAll("button")].map((button) => {
              const rect = button.getBoundingClientRect();
              return { label: button.getAttribute("aria-label") ?? button.textContent.trim(), top: rect.top, left: rect.left, right: rect.right };
            });
            return { buttons, fitsParent: bounds.left >= parent.left - 1 && bounds.right <= parent.right + 1,
              scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
          });
          const context = `${component} ${theme} width=${width} activeRuns=${count}`;
          assert(measurements.fitsParent, `${context}: toolbar exceeds its parent`);
          assert(measurements.buttons.every((button) => Math.abs(button.top - measurements.buttons[0].top) < 1),
            `${context}: action buttons wrapped: ${JSON.stringify(measurements.buttons)}`);
          assert(measurements.buttons.slice(1).every((button, index) => button.left >= measurements.buttons[index].right), `${context}: overlapping buttons`);
          // Focus must reveal even the last Stop when many runs require scrolling.
          for (const button of await toolbar.getByRole("button").all()) {
            if (await button.isDisabled()) continue;
            await button.focus();
            assert(await button.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return document.activeElement === element && (hit === element || element.contains(hit));
            }), `${context}: focused action is clipped or covered: ${JSON.stringify(await button.evaluate(el => ({ label: el.getAttribute("aria-label") ?? el.textContent, rect: el.getBoundingClientRect().toJSON(), scrollLeft: el.parentElement.scrollLeft, toolbar: el.parentElement.getBoundingClientRect().toJSON(), hit: document.elementFromPoint(el.getBoundingClientRect().x + el.getBoundingClientRect().width / 2, el.getBoundingClientRect().y + el.getBoundingClientRect().height / 2)?.outerHTML.slice(0, 200) })))}`);
          }
          if (count) {
            const stop = toolbar.getByRole("button", { name: `Stop run active-${count - 1}`, exact: true });
            if (component === "card") {
              await page.evaluate(() => { window.failCancellation = true; });
              await stop.click();
              await page.getByRole("alert").filter({ hasText: "Cancellation failed" }).waitFor();
              await page.evaluate(() => { window.failCancellation = false; });
            }
            await stop.click();
            assert.equal(await page.evaluate(() => window.cancelled.at(-1)), `active-${count - 1}`);
          }
          console.log(`${context}: PASS (one row; toolbar ${measurements.clientWidth}px, content ${measurements.scrollWidth}px)`);
        }
      }
    }
  }
} finally {
  await browser.close();
}
