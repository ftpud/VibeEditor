import { expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isTrustedIpcFrame, isTrustedRendererUrl } from "./navigation-policy.js";

const renderer = path.resolve("/app/dist-renderer/index.html");
const rendererUrl = pathToFileURL(renderer).toString();

it("allows the configured file document and query state only", () => {
  expect(isTrustedRendererUrl(rendererUrl, renderer)).toBe(true);
  expect(isTrustedRendererUrl(`${rendererUrl}?detached=1&path=src%2Fmain.ts`, renderer)).toBe(true);
  expect(isTrustedRendererUrl(`${rendererUrl}#editor`, renderer)).toBe(true);
  expect(isTrustedRendererUrl("file:///app/other.html", renderer)).toBe(false);
  expect(isTrustedRendererUrl("file:///etc/passwd", renderer)).toBe(false);
  expect(isTrustedRendererUrl("file://remote/app/dist-renderer/index.html", renderer)).toBe(false);
});

it("allows only the configured dev origin and document route", () => {
  const dev = "http://localhost:5173/";
  expect(isTrustedRendererUrl(dev, renderer, dev)).toBe(true);
  expect(isTrustedRendererUrl(`${dev}?detached=1`, renderer, dev)).toBe(true);
  expect(isTrustedRendererUrl("http://localhost:5173/other", renderer, dev)).toBe(false);
  expect(isTrustedRendererUrl("http://localhost:5174/", renderer, dev)).toBe(false);
  expect(isTrustedRendererUrl("https://localhost:5173/", renderer, dev)).toBe(false);
  expect(isTrustedRendererUrl("http://user@localhost:5173/", renderer, dev)).toBe(false);
});

it("trusts IPC only from an owned window's trusted top-level frame", () => {
  expect(isTrustedIpcFrame({ url: `${rendererUrl}?detached=1`, isMainFrame: true }, true, renderer)).toBe(true);
  expect(isTrustedIpcFrame({ url: rendererUrl, isMainFrame: false }, true, renderer)).toBe(false);
  expect(isTrustedIpcFrame({ url: "file:///tmp/attacker.html", isMainFrame: true }, true, renderer)).toBe(false);
  expect(isTrustedIpcFrame({ url: rendererUrl, isMainFrame: true }, false, renderer)).toBe(false);
  expect(isTrustedIpcFrame(undefined, true, renderer)).toBe(false);
});
