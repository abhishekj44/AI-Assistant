/**
 * Technical Keyterms Dictionary & Extractor for Deepgram Nova-3
 * Formats terms cleanly for Nova-3's `keyterm` parameter.
 */

export const DEFAULT_TECHNICAL_KEYTERMS: string[] = [
  "TypeScript", "JavaScript", "Python", "Golang", "Rust", "Java", "Node",
  "React", "Next.js", "GraphQL", "WebSockets", "WebRTC", "Redux",
  "REST", "gRPC", "Protobuf", "Microservices", "OAuth2", "FastAPI",
  "PostgreSQL", "MongoDB", "Redis", "Elasticsearch", "Pinecone",
  "Kubernetes", "Docker", "AWS", "Terraform", "Kafka",
  "ACID", "Sharding", "Replication", "Deadlock", "Concurrency", "Idempotency",
  "RAG", "Embeddings", "Vector Search", "Gemini", "Deepgram"
];

/**
 * Extract domain-specific keyterms from background text or user resume
 */
export function extractCustomKeyterms(bgText?: string): string[] {
  if (!bgText) return [];
  
  const words = bgText
    .split(/[\s,.;:()]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && /^[A-Za-z0-9.-]+$/.test(w));
  
  return Array.from(new Set(words)).slice(0, 20);
}

/**
 * Build clean keyterm list for Deepgram Nova-3 (capped at 30 items)
 */
export function getCombinedKeyterms(customBg?: string): string[] {
  const custom = extractCustomKeyterms(customBg);
  const combined = Array.from(new Set([...custom, ...DEFAULT_TECHNICAL_KEYTERMS]));
  return combined.slice(0, 30);
}
