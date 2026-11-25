import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs Node.js syntax validation against every emitted JavaScript file.
 * This prevents stale or hand-edited TypeScript syntax from reaching startup.
 */
function collectJavaScript(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const filePath = path.join(directory, entry);
    if (statSync(filePath).isDirectory()) {
      files.push(...collectJavaScript(filePath));
    } else if (filePath.endsWith(".js")) {
      files.push(filePath);
    }
  }
  return files;
}

const files = collectJavaScript("root/dist");
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `Syntax check failed: ${file}\n`);
    process.exit(result.status ?? 1);
  }
}

console.log(`Checked ${files.length} compiled JavaScript files.`);
