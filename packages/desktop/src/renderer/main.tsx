import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import { App } from "./App";
import { DetachedEditor } from "./DetachedEditor";
import "./styles.css";

document.documentElement.dataset.theme = localStorage.getItem("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.platform = navigator.platform.toLowerCase().includes("win") ? "windows" : navigator.platform.toLowerCase().includes("mac") ? "mac" : "linux";
const detached = new URLSearchParams(window.location.search).get("detached") === "1";
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode>{detached ? <DetachedEditor /> : <App />}</React.StrictMode>);
