const fs = require("node:fs");
const path = require("node:path");

for (const relativePath of [".next", "tsconfig.tsbuildinfo"]) {
  const absolutePath = path.join(process.cwd(), relativePath);
  if (!fs.existsSync(absolutePath)) continue;
  fs.rmSync(absolutePath, { recursive: true, force: true });
  console.log(`Removed build cache: ${relativePath}`);
}
