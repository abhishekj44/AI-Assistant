export interface WebSearchResult {
  title: string;
  link: string;
  snippet: string;
  source: string;
  score: number;
}

export interface SearchResponse {
  results: WebSearchResult[];
  searchQuery: string;
  totalResults: number;
}

class SimpleWebSearchAgent {
  async searchWeb(query: string, numResults = 3, signal?: AbortSignal): Promise<SearchResponse> {
    const apiKey = process.env.TAVILY_API_KEY?.trim();
    if (!apiKey) return { results: [], searchQuery: query, totalResults: 0 };

    try {
      // Direct HTTP keeps timeout/cancellation under our control and avoids fake fallback content.
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: "basic",
          include_answer: false,
          include_images: false,
          include_raw_content: false,
          max_results: numResults,
        }),
        signal,
      });
      if (!response.ok) throw new Error(`Tavily returned HTTP ${response.status}`);
      const payload = await response.json();
      const results: WebSearchResult[] = Array.isArray(payload?.results)
        ? payload.results.slice(0, numResults).map((result: any, index: number) => {
            let host = "web";
            try { host = new URL(result.url).hostname; } catch {}
            return {
              title: result.title || `Result ${index + 1}`,
              link: result.url || "",
              snippet: result.content || "",
              source: host,
              score: typeof result.score === "number" ? result.score : 0,
            };
          })
        : [];
      const usableResults = results.filter((result) => /^https?:\/\//i.test(result.link));
      return { results: usableResults, searchQuery: query, totalResults: usableResults.length };
    } catch (error: any) {
      if (error?.name !== "AbortError" && error?.name !== "TimeoutError") {
        console.warn("[web] search failed:", error?.message || error);
      }
      return { results: [], searchQuery: query, totalResults: 0 };
    }
  }
}

export const webSearchAgent = new SimpleWebSearchAgent();
