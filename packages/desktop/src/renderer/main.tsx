import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import { App } from "./App";
import { DetachedEditor } from "./DetachedEditor";
import "./styles.css";

document.documentElement.dataset.theme = localStorage.getItem("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.platform = navigator.platform.toLowerCase().includes("win") ? "windows" : navigator.platform.toLowerCase().includes("mac") ? "mac" : "linux";
document.documentElement.style.setProperty("--ui-font-family", localStorage.getItem("uiFontFamily") === "inter" ? '"Inter Variable"' : '"JetBrains Mono Variable"');
document.documentElement.style.setProperty("--ui-font-size", `${Math.min(20, Math.max(10, Number(localStorage.getItem("uiFontSize")) || 13))}px`);
document.documentElement.style.setProperty("--ui-line-height", String(Math.min(2, Math.max(1, Number(localStorage.getItem("uiLineHeight")) || 1.2))));
const detached = new URLSearchParams(window.location.search).get("detached") === "1";
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode>{detached ? <DetachedEditor /> : <App />}</React.StrictMode>);
