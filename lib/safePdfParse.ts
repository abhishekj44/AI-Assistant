export interface ParsedPdfText {
  text: string;
  numpages?: number;
  info?: unknown;
  metadata?: unknown;
  version?: string;
}

type PdfParseResult = {
  text?: string;
  numpages?: number;
  info?: unknown;
  metadata?: unknown;
  version?: string;
};

type PdfParseFunction = (buffer: Buffer) => Promise<PdfParseResult>;

let parserPromise: Promise<PdfParseFunction> | null = null;

/**
 * pdf-parse@1.x exposes a package-root debug harness that reads
 * ./test/data/05-versions-space.pdf when some bundlers evaluate the module.
 * Import the implementation module lazily instead so Next.js can collect
 * route metadata without executing that debug harness during `next build`.
 */
async function getPdfParser(): Promise<PdfParseFunction> {
  if (!parserPromise) {
    parserPromise = import("pdf-parse/lib/pdf-parse.js")
      .then((module) => {
        const parser = module.default;
        if (typeof parser !== "function") {
          throw new Error("PDF parser implementation did not export a function");
        }
        return parser as PdfParseFunction;
      })
      .catch((error) => {
        // Allow a later request to retry module loading after a transient failure.
        parserPromise = null;
        throw error;
      });
  }

  return parserPromise;
}

/**
 * Server-only PDF text extraction with stable, user-facing errors.
 * Knowledge ingestion intentionally rejects scanned/encrypted PDFs rather than
 * invoking OCR on the latency-sensitive application server.
 */
export async function safePdfParse(buffer: Buffer): Promise<ParsedPdfText> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("PDF is empty");
  }

  try {
    const pdfParse = await getPdfParser();
    const parsed = await pdfParse(buffer);

    return {
      text: String(parsed?.text || ""),
      numpages: parsed?.numpages,
      info: parsed?.info,
      metadata: parsed?.metadata,
      version: parsed?.version,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "PDF parsing failed");

    if (/password|encrypted|decrypt/i.test(message)) {
      throw new Error("The PDF is encrypted. Upload an unencrypted copy for Candidate Knowledge extraction.");
    }
    if (/invalid|malformed|xref|pdf/i.test(message)) {
      throw new Error(`The PDF could not be parsed: ${message.slice(0, 240)}`);
    }

    throw error;
  }
}
