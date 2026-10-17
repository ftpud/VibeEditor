import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { isTrustedIpcFrame, isTrustedRendererUrl } from "./navigation-policy.js";

const renderer = "/app/dist-renderer/index.html";
const document = pathToFileURL(renderer).href;
test("trusts the exact packaged renderer document and no other file or origin", () => {
  assert.equal(isTrustedRendererUrl(`${document}?detached=1#editor`, renderer), true);
  for (const url of ["https://evil.test", "file:///etc/passwd", "file://remote/app/dist-renderer/index.html", "javascript:alert(1)", "not a url"]) assert.equal(isTrustedRendererUrl(url, renderer), false);
});
test("development trust is limited to the configured origin and document route", () => {
  assert.equal(isTrustedRendererUrl("http://localhost:5174/?x=1", renderer, "http://localhost:5174/"), true);
  for (const url of ["http://localhost:5174/other", "http://localhost:5174.evil.test/", "http://localhost:5173/", "http://user@localhost:5174/"]) assert.equal(isTrustedRendererUrl(url, renderer, "http://localhost:5174/"), false);
});
test("packaged renderer trust handles Chromium's escaped Windows temp directory names", () => {
  const renderer = "/Users/RUNNER~1/Vibe Gateway/dist-renderer/index.html";
  const document = pathToFileURL(renderer).href;
  assert.equal(isTrustedIpcFrame({ url: document.replace(/~|%7e/i, "%7E"), isMainFrame: true }, true, renderer), true);
  assert.equal(isTrustedRendererUrl(document.replace(/~|%7e/i, "%7e"), renderer), true);
  for (const candidate of [document.replace("index.html", "other.html"), document.replace("index.html", "index.html%2Fother"), document + "%", document.replace(/RUNNER(?:~|%7e)1/i, "OTHER~1")]) {
    assert.equal(isTrustedRendererUrl(candidate, renderer), false);
  }
});
test("IPC requires an app-owned window and the trusted top-level frame", () => {
  assert.equal(isTrustedIpcFrame({ url: document, isMainFrame: true }, true, renderer), true);
  assert.equal(isTrustedIpcFrame({ url: document, isMainFrame: false }, true, renderer), false);
  assert.equal(isTrustedIpcFrame({ url: document, isMainFrame: true }, false, renderer), false);
  assert.equal(isTrustedIpcFrame(null, true, renderer), false);
  assert.equal(isTrustedIpcFrame({ url: "https://evil.test", isMainFrame: true }, true, renderer), false);
});
