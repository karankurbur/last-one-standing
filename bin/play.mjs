#!/usr/bin/env node
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const playScript = join(__dirname, "..", "src", "play.ts");

try {
  execFileSync("npx", ["tsx", playScript, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env },
  });
} catch (e) {
  process.exit(e.status ?? 1);
}
