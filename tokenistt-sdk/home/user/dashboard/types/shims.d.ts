// Minimal type shims for packages that don't ship their own declarations.

declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
  }
  const pdfParse: (data: Buffer | Uint8Array) => Promise<PdfParseResult>;
  export default pdfParse;
}

declare module "pdf-parse" {
  const pdfParse: (data: Buffer | Uint8Array) => Promise<{
    text: string;
    [key: string]: unknown;
  }>;
  export default pdfParse;
}
