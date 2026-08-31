import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const windows = process.platform === "win32";
const daemonName = windows ? "copilot-sessionsd.exe" : "copilot-sessionsd";
const root = process.cwd();
const webTarget = join(root, "src-tauri", "web");
const binTarget = join(root, "src-tauri", "bin");

await rm(webTarget, { recursive: true, force: true });
await mkdir(webTarget, { recursive: true });
await mkdir(binTarget, { recursive: true });
await cp(join(root, "dist"), webTarget, { recursive: true });
await cp(
  join(root, "target", "release", daemonName),
  join(binTarget, daemonName),
);
