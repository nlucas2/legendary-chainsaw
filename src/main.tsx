import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { isTauri } from "./lib/daemon";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

async function start() {
  if (isTauri()) {
    root.render(<main style={{ padding: "2rem", fontFamily: "system-ui" }}>Starting Copilot Sessions...</main>);
    try {
      await invoke("ensure_daemon");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      root.render(
        <main style={{ padding: "2rem", fontFamily: "system-ui" }}>
          <h1>Copilot Sessions could not start</h1>
          <pre style={{ whiteSpace: "pre-wrap" }}>{message}</pre>
        </main>,
      );
      return;
    }
  }
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
