import { Pinecone } from '@pinecone-database/pinecone';
import gemini, { EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_MODEL, GEMINI_MODEL } from '../gemini';
import { safePdfParse } from '../safePdfParse';

export interface PDFDocument {
  id: string;
  title: string;
  content: string;
  chunks: string[];
  metadata: {
    filename: string;
    uploadDate: string;
    pageCount: number;
    contentType: 'text' | 'multimodal';
  };
}

export interface SearchResult {
  content: string;
  score: number;
  metadata: any;
  source: string;
  contentType?: 'text' | 'image' | 'multimodal';
  page?: number;
  startPage?: number;
  endPage?: number;
}

class PineconeService {
  private pinecone: Pinecone | null = null;
  private geminiEnabled = false;
  private indexName: string;

  constructor() {
    this.indexName = process.env.PINECONE_INDEX_NAME || 'interview-docs';
    this.initialize();
  }

  private async initialize() {
    try {
      if (process.env.PINECONE_API_KEY) {
        this.pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
      } else {
        console.warn('PINECONE_API_KEY not found — PDF search disabled');
      }

      if (process.env.GEMINI_API_KEY) {
        this.geminiEnabled = true;
      } else {
        console.warn('GEMINI_API_KEY not found — embeddings disabled');
      }
    } catch (error) {
      console.error('Pinecone init failed:', (error as Error).message);
    }
  }

  async uploadPDF(file: File): Promise<PDFDocument | null> {
    try {
      if (!this.pinecone || !this.geminiEnabled) {
        throw new Error('Pinecone or Gemini not initialized');
      }

      if (!file.name.toLowerCase().endsWith('.pdf')) {
        throw new Error('Only PDF files are supported');
      }
      if (file.size === 0) {
        throw new Error('File is empty');
      }
      if (file.size > 10 * 1024 * 1024) {
        throw new Error('File is too large (max 10MB)');
      }

      const arrayBuffer = await file.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        throw new Error('Invalid file buffer');
      }

      const buffer = Buffer.from(arrayBuffer);
      const pdfData = await safePdfParse(buffer);

      if (!pdfData.text || pdfData.text.trim().length === 0) {
        throw new Error('No text content found in PDF');
      }

      console.log(`PDF parsed: ${pdfData.numpages} pages, ${pdfData.text.length} chars`);

      const chunksWithPages = this.splitIntoChunksWithPages(pdfData, 150);

      // Filter out chunks that are too short or mostly whitespace
      const validChunks = chunksWithPages.filter((chunk) => {
        const cleanContent = chunk.content.trim().replace(/\s+/g, ' ');
        const wordCount = cleanContent.split(' ').length;
        return cleanContent.length > 20 && wordCount > 5 && /[a-zA-Z0-9]/.test(cleanContent);
      });

      console.log(`${validChunks.length} valid chunks (filtered ${chunksWithPages.length - validChunks.length})`);

      const index = this.pinecone.index(this.indexName);
      const vectors = [];
      let failedEmbeddings = 0;

      for (let i = 0; i < validChunks.length; i++) {
        const chunkData = validChunks[i];
        try {
          const cleanContent = chunkData.content.trim().replace(/\s+/g, ' ');
          const wordCount = cleanContent.split(' ').length;

          const embedding = await this.generateEmbedding(cleanContent);
          vectors.push({
            id: `${file.name}-chunk-${i}`,
            values: embedding,
            metadata: {
              content: cleanContent,
              filename: file.name,
              chunkIndex: i,
              title: file.name.replace('.pdf', ''),
              uploadDate: new Date().toISOString(),
              page: chunkData.page,
              startPage: chunkData.startPage,
              endPage: chunkData.endPage,
              wordCount,
              charCount: cleanContent.length,
            },
          });

          // Rate-limit pause every 3 chunks
          if (i > 0 && i % 3 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        } catch (embeddingError) {
          failedEmbeddings++;
          console.error(`Embedding failed for chunk ${i}:`, (embeddingError as Error).message);
        }
      }

      if (failedEmbeddings > 0) {
        console.warn(`${failedEmbeddings} embedding(s) failed`);
      }

      if (vectors.length === 0) {
        throw new Error('No embeddings generated successfully');
      }

      await index.upsert(vectors);
      console.log(`PDF upload complete: ${vectors.length} vectors stored`);

      return {
        id: file.name,
        title: file.name.replace('.pdf', ''),
        content: pdfData.text,
        chunks: chunksWithPages.map((c) => c.content),
        metadata: {
          filename: file.name,
          uploadDate: new Date().toISOString(),
          pageCount: pdfData.numpages || 0,
          contentType: 'text' as const,
        },
      };
    } catch (error) {
      console.error('PDF upload error:', (error as Error).message);
      return null;
    }
  }

  async searchSimilarContent(query: string, topK: number = 5): Promise<SearchResult[]> {
    try {
      if (!this.pinecone || !this.geminiEnabled) {
        return [];
      }

      const queryEmbedding = await this.generateEmbedding(query);
      const index = this.pinecone.index(this.indexName);

      const searchResponse = await index.query({
        vector: queryEmbedding,
        topK,
        includeMetadata: true,
      });

      return (
        searchResponse.matches?.map((match) => ({
          content: (match.metadata?.content as string) || '',
          score: match.score || 0,
          metadata: match.metadata,
          source: `PDF: ${match.metadata?.filename || 'Unknown'}`,
          page: typeof match.metadata?.page === 'number' ? match.metadata.page : 1,
          startPage: typeof match.metadata?.startPage === 'number' ? match.metadata.startPage : 1,
          endPage: typeof match.metadata?.endPage === 'number' ? match.metadata.endPage : 1,
        })) || []
      );
    } catch (error) {
      console.error('Pinecone search error:', (error as Error).message);
      return [];
    }
  }

  private async generateEmbedding(
    text: string,
    contentType: 'text' | 'multimodal' = 'text',
  ): Promise<number[]> {
    if (!this.geminiEnabled) {
      throw new Error('Gemini not initialized');
    }

    // Clean and prepare text
    let processedText = text.trim().replace(/\s+/g, ' ');

    // Conservative limits well below Gemini's actual limits
    const maxChars = 1500;
    const maxWords = 300;
    const words = processedText.split(' ');

    if (words.length > maxWords) {
      processedText = words.slice(0, maxWords).join(' ');
    }
    if (processedText.length > maxChars) {
      processedText = processedText.substring(0, maxChars);
      const lastSpace = processedText.lastIndexOf(' ');
      if (lastSpace > maxChars * 0.8) {
        processedText = processedText.substring(0, lastSpace);
      }
    }

    if (processedText.length < 10) {
      throw new Error('Text too short for meaningful embedding');
    }

    const result = await gemini.models.embedContent({
      model: GEMINI_EMBEDDING_MODEL,
      contents: processedText,
      config: { outputDimensionality: EMBEDDING_DIMENSIONS },
    });

    const embedding = result.embeddings?.[0];
    if (!embedding?.values) {
      throw new Error('Invalid embedding response from Gemini');
    }

    return embedding.values;
  }

  private splitIntoChunksWithPages(
    pdfData: any,
    chunkSize: number,
  ): Array<{ content: string; page: number; startPage: number; endPage: number }> {
    const cleanedText = pdfData.text
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s{3,}/g, ' ')
      .trim();

    const sentences = cleanedText.split(/[.!?]+/).filter((s: string) => s.trim().length > 0);
    const chunks: Array<{ content: string; page: number; startPage: number; endPage: number }> = [];
    const avgCharsPerPage = Math.ceil(cleanedText.length / (pdfData.numpages || 1));

    let currentChunk = '';
    let currentWordCount = 0;
    let chunkStartPos = 0;

    for (const sentence of sentences) {
      const sentenceWords = sentence.trim().split(' ').length;
      const sentenceText = sentence.trim() + '. ';

      if (currentWordCount + sentenceWords > chunkSize && currentChunk.length > 0) {
        const chunkEnd = chunkStartPos + currentChunk.length;
        const startPage = Math.max(1, Math.ceil(chunkStartPos / avgCharsPerPage));
        const endPage = Math.min(pdfData.numpages || 1, Math.ceil(chunkEnd / avgCharsPerPage));

        chunks.push({ content: currentChunk.trim(), page: startPage, startPage, endPage });

        chunkStartPos = chunkEnd;
        currentChunk = sentenceText;
        currentWordCount = sentenceWords;
      } else {
        currentChunk += sentenceText;
        currentWordCount += sentenceWords;
      }
    }

    if (currentChunk.trim().length > 0) {
      const chunkEnd = chunkStartPos + currentChunk.length;
      const startPage = Math.max(1, Math.ceil(chunkStartPos / avgCharsPerPage));
      const endPage = Math.min(pdfData.numpages || 1, Math.ceil(chunkEnd / avgCharsPerPage));
      chunks.push({ content: currentChunk.trim(), page: startPage, startPage, endPage });
    }

    return chunks;
  }

  async deleteDocument(filename: string): Promise<boolean> {
    try {
      if (!this.pinecone) return false;

      const index = this.pinecone.index(this.indexName);
      const searchResponse = await index.query({
        vector: new Array(EMBEDDING_DIMENSIONS).fill(0),
        topK: 10000,
        includeMetadata: true,
        filter: { filename: { $eq: filename } },
      });

      if (searchResponse.matches && searchResponse.matches.length > 0) {
        const idsToDelete = searchResponse.matches.map((match) => match.id);
        await index.deleteMany(idsToDelete);
      }

      return true;
    } catch (error) {
      console.error('Delete document error:', (error as Error).message);
      return false;
    }
  }
}

export const pineconeService = new PineconeService();
