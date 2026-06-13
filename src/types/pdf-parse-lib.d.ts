// pdf-parse's main entry runs a debug harness when imported with no parent
// module, which breaks under bundlers. Import the inner lib directly instead.
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
  }
  function pdf(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export default pdf;
}
