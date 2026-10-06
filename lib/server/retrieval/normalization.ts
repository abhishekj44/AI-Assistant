export function normalizeSearch(text: string): string {
  return text.toLowerCase()
    .replace(/\bc\+\+/g, " cpp ")
    .replace(/\bc#/g, " csharp ")
    .replace(/\.net\b/g, " dotnet ")
    .replace(/\bnode\.?js\b/g, " nodejs ")
    .replace(/retrieval[\s-]?augmented[\s-]?generation/g, " rag ")
    .replace(/fine[\s-]?tun(?:e|ing|ed)/g, " finetune ")
    .replace(/vision[\s-]?language[\s-]?models?/g, " vlm ")
    .replace(/multi[\s-]?modal/g, " multimodal ")
    .replace(/object[\s-]?detection/g, " objectdetection ")
    .replace(/computer[\s-]?vision/g, " computervision ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

const stopWords = new Set("the and that this with from have your what when where which would could should about into there their they were been then than also just using used tell explain describe you how did does why can for are was our out get got me my like approach".split(" "));

export function searchTokens(text: string): string[] {
  return [...new Set(normalizeSearch(text).split(" ").filter((token) => token && !stopWords.has(token)))].slice(0, 32);
}

export function lexicalAliases(text: string): string {
  const aliases: Record<string, string> = { cpp: "C++", csharp: "C#", dotnet: ".NET", nodejs: "Node.js" };
  return searchTokens(text).flatMap((token) => aliases[token] ? [token, aliases[token]] : [token]).join(" ");
}