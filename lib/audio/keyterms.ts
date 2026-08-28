/** High-value technical vocabulary hints for Deepgram Nova-3. */
export const DEFAULT_TECHNICAL_KEYTERMS: string[] = [
  "VLM", "vLLM", "YOLOv8", "Nemotron", "NVIDIA NIM", "NIM", "LangGraph", "Agentic AI",
  "multimodal", "RAG", "Embeddings", "Vector Search", "MCP", "ACP", "OpenID", "OAuth2",
  "Kubernetes", "Docker", "Azure", "AWS", "FastAPI", "PostgreSQL", "Redis", "Kafka",
  "WebSockets", "WebRTC", "gRPC", "Terraform", "Gemini", "Deepgram", "Pydantic",
];

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

/** Extract explicitly tagged knowledge terms plus acronym/version-like tokens from candidate notes. */
export function extractCustomKeyterms(bgText?: string): string[] {
  if (!bgText) return [];
  const explicit = Array.from(bgText.matchAll(/^\[TERM\]\s*(.+)$/gim)).map((match) => match[1].trim());
  const techLike = bgText.match(/\b(?:[A-Z]{2,}[A-Za-z0-9.+-]*|[A-Za-z]+\d+(?:\.\d+)*|[A-Za-z]+\.[A-Za-z]+)\b/g) || [];
  return uniqueCaseInsensitive([...explicit, ...techLike]).slice(0, 24);
}

/** Reserve space for high-value model/domain terms while still prioritizing session-specific vocabulary. */
export function getCombinedKeyterms(customBg?: string): string[] {
  const custom = extractCustomKeyterms(customBg);
  const core = DEFAULT_TECHNICAL_KEYTERMS.slice(0, 14);
  const remainder = DEFAULT_TECHNICAL_KEYTERMS.slice(14);
  return uniqueCaseInsensitive([...core, ...custom.slice(0, 16), ...remainder]).slice(0, 30);
}
