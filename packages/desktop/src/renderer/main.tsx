import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { DetachedEditor } from "./DetachedEditor";
import "./styles.css";

const detached = new URLSearchParams(window.location.search).get("detached") === "1";
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode>{detached ? <DetachedEditor /> : <App />}</React.StrictMode>);
