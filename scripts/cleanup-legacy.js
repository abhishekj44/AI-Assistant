const fs = require("node:fs");
const path = require("node:path");

const stalePaths = [
  "app/api/pdf/route.ts",
  "lib/agents/pineconeService.ts",
  "lib/agents/ragOrchestrator.ts",
];

let removed = 0;
for (const relativePath of stalePaths) {
  const absolutePath = path.join(process.cwd(), relativePath);
  if (!fs.existsSync(absolutePath)) continue;
  fs.rmSync(absolutePath, { force: true });
  console.log(`Removed legacy file: ${relativePath}`);
  removed += 1;
}

console.log(removed ? `Legacy cleanup complete (${removed} file(s) removed).` : "No legacy Pinecone/RAG files found.");
