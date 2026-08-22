import { ExtractedQuestion } from '@/lib/types';
import { extractQuestionLocally, generateSearchQuery } from './localQuestionExtractor';
import { pineconeService, SearchResult } from './pineconeService';
import { webSearchAgent, WebSearchResult } from './simpleWebSearchAgent';

export interface RAGContext {
  pdfResults: SearchResult[];
  webResults: WebSearchResult[];
  combinedContext: string;
  citations: Citation[];
}

export interface Citation {
  source: string;
  content: string;
  url?: string;
  score: number;
  page?: number;
  startPage?: number;
  endPage?: number;
  filename?: string;
  sourceType: 'pdf' | 'web';
  contextSnippet?: string;
  pageRange?: string;
  contentType?: 'text' | 'image' | 'multimodal';
}

export interface RAGResponse {
  extractedQuestion: ExtractedQuestion | null;
  context: RAGContext;
  searchPerformed: boolean;
}

/** Timeout (ms) for individual search operations. */
const SEARCH_TIMEOUT_MS = 8_000;

/**
 * Race a promise against a timeout. Returns `fallback` if the timeout fires.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/**
 * Deterministic web search router.
 * Returns true only when the question contains freshness signals that
 * warrant a real-time web lookup. Most interview questions skip this entirely.
 */
function needsWebSearch(question: string): boolean {
  return /\b(latest|current|recent|version|pricing|released|news|today|announce|update|2025|2026|2027)\b/i.test(question);
}

class RAGOrchestrator {
  /**
   * V2: focusQuestion is resolved client-side (last speaker turn).
   * No LLM extraction call on the critical path.
   */
  async processTranscript(transcript: string, background?: string, focusQuestion?: string): Promise<RAGResponse> {
    try {
      // ── Step 1: Determine search query ─────────────────────────────────
      // Use the client-provided focus question directly.
      // Fall back to local regex extraction only for generating a search query.
      let searchQuery = focusQuestion || '';
      let extractedQuestion: ExtractedQuestion | null = null;

      if (focusQuestion) {
        extractedQuestion = {
          question: focusQuestion,
          context: '',
          confidence: 1.0, // Client explicitly selected this turn
        };
      } else {
        // Fallback: local regex extraction (instant, no API call)
        const localQuestion = extractQuestionLocally(transcript);
        if (localQuestion && localQuestion.confidence >= 0.4) {
          extractedQuestion = {
            question: localQuestion.question,
            context: localQuestion.context,
            confidence: localQuestion.confidence,
          };
          searchQuery = localQuestion.question;
        } else {
          searchQuery = generateSearchQuery(transcript);
        }
      }

      // Skip RAG if no meaningful query.
      if (!searchQuery || searchQuery.length < 10) {
        return emptyResponse();
      }

      // ── Step 2: Routed search — PDF always, Web only when needed ───────
      const searchPromises: [Promise<SearchResult[]>, Promise<{ results: WebSearchResult[] }>] = [
        withTimeout(
          this.searchPDFs(searchQuery),
          SEARCH_TIMEOUT_MS,
          [],
        ),
        needsWebSearch(searchQuery)
          ? withTimeout(
              this.searchWeb(searchQuery, background),
              SEARCH_TIMEOUT_MS,
              { results: [] as WebSearchResult[] },
            )
          : Promise.resolve({ results: [] as WebSearchResult[] }),
      ];

      const [pdfResults, webSearchResponse] = await Promise.all(searchPromises);

      // ── Step 3: Combine and rank results ──────────────────────────────
      const context = this.combineContexts(pdfResults, webSearchResponse.results);

      return {
        extractedQuestion,
        context,
        searchPerformed: true,
      };
    } catch (error) {
      console.error('RAG processing error:', (error as Error).message);
      return emptyResponse();
    }
  }

  private async searchPDFs(question: string): Promise<SearchResult[]> {
    try {
      return await pineconeService.searchSimilarContent(question, 3);
    } catch (error) {
      console.error('PDF search error:', (error as Error).message);
      return [];
    }
  }

  private async searchWeb(
    question: string,
    background?: string,
  ): Promise<{ results: WebSearchResult[] }> {
    try {
      let searchQuery = question;
      if (background) {
        const keywords = extractKeywords(background);
        if (keywords.length > 0) {
          searchQuery = `${question} ${keywords.slice(0, 3).join(' ')}`;
        }
      }

      const webResponse = await webSearchAgent.searchWeb(searchQuery, 3);
      return { results: webResponse.results };
    } catch (error) {
      console.error('Web search error:', (error as Error).message);
      return { results: [] };
    }
  }

  private combineContexts(pdfResults: SearchResult[], webResults: WebSearchResult[]): RAGContext {
    const allResults = [
      ...pdfResults.map((r) => ({ ...r, type: 'pdf' as const, priority: 1 })),
      ...webResults.map((r) => ({
        ...r,
        content: r.snippet,
        type: 'web' as const,
        priority: 2,
      })),
    ];

    // Sort: PDF first, then by relevance score.
    allResults.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.score - a.score;
    });

    const topResults = allResults.slice(0, 4);
    const contextParts: string[] = [];
    const citations: Citation[] = [];

    for (const result of topResults) {
      const content = result.content.substring(0, 500);
      const isPdf = result.type === 'pdf';
      const sourceTag = isPdf ? '[PDF]' : '[WEB]';

      let contextInfo = '';
      if (isPdf) {
        const pageInfo = formatPageInfo(result);
        contextInfo = `${sourceTag} ${pageInfo ? `(${pageInfo}) ` : ''}${content}`;
      } else {
        contextInfo = `${sourceTag} ${content}`;
      }

      contextParts.push(contextInfo);

      citations.push({
        source: result.source,
        content,
        url: !isPdf ? (result as any).link : undefined,
        score: result.score,
        sourceType: result.type,
        page: isPdf ? (result as any).page : undefined,
        startPage: isPdf ? (result as any).startPage : undefined,
        endPage: isPdf ? (result as any).endPage : undefined,
        filename: isPdf ? (result as any).metadata?.filename || result.source : undefined,
        pageRange: isPdf ? formatPageInfo(result) : undefined,
        contextSnippet: content.substring(0, 150) + (content.length > 150 ? '...' : ''),
      });
    }

    return {
      pdfResults,
      webResults,
      combinedContext: contextParts.join('\n\n'),
      citations,
    };
  }

  // ── Utility: PDF management ─────────────────────────────────────────

  async uploadPDF(file: File): Promise<boolean> {
    try {
      const result = await pineconeService.uploadPDF(file);
      return result !== null;
    } catch (error) {
      console.error('Error uploading PDF:', (error as Error).message);
      return false;
    }
  }

  async deletePDF(filename: string): Promise<boolean> {
    try {
      return await pineconeService.deleteDocument(filename);
    } catch (error) {
      console.error('Error deleting PDF:', (error as Error).message);
      return false;
    }
  }
}

// ── Helper functions (module-level) ───────────────────────────────────

function emptyResponse(): RAGResponse {
  return {
    extractedQuestion: null,
    context: { pdfResults: [], webResults: [], combinedContext: '', citations: [] },
    searchPerformed: false,
  };
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'this', 'that', 'with', 'have', 'will', 'from', 'they', 'been',
    'were', 'said', 'each', 'which', 'their', 'time', 'about',
  ]);
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w))
    .slice(0, 5);
}

function formatPageInfo(result: any): string {
  if (!result || result.type !== 'pdf') return '';
  const { startPage, endPage, page } = result;
  if (startPage && endPage && startPage !== endPage) return `Pages ${startPage}-${endPage}`;
  if (page) return `Page ${page}`;
  if (startPage) return `Page ${startPage}`;
  return '';
}

export const ragOrchestrator = new RAGOrchestrator();
