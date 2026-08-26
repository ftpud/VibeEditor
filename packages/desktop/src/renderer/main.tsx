import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import { App } from "./App";
import { readSetting, readSettingNumber } from "./settings";
import { DetachedEditor } from "./DetachedEditor";
import "./styles.css";

document.documentElement.dataset.theme = readSetting("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.platform = navigator.platform.toLowerCase().includes("win") ? "windows" : navigator.platform.toLowerCase().includes("mac") ? "mac" : "linux";
document.documentElement.style.setProperty("--ui-font-family", readSetting("uiFontFamily") === "inter" ? '"Inter Variable"' : '"JetBrains Mono Variable"');
document.documentElement.style.setProperty("--ui-font-size", `${readSettingNumber("uiFontSize", 13, 10, 20)}px`);
document.documentElement.style.setProperty("--ui-line-height", String(readSettingNumber("uiLineHeight", 1.2, 1, 2)));
const detached = new URLSearchParams(window.location.search).get("detached") === "1";
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode>{detached ? <DetachedEditor /> : <App />}</React.StrictMode>);
