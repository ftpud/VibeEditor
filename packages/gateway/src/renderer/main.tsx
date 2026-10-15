import { installGatewayWindowChrome } from "./window-chrome";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./design-tokens.css";
import "./styles.css";

const removeWindowChrome = installGatewayWindowChrome(document.documentElement, window.gateway);
if (import.meta.hot) import.meta.hot.dispose(removeWindowChrome);

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
