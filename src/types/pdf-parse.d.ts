// Ambient declaration for the pdf-parse subpath import.
//
// `pdf-parse@1.1.1`'s top-level entry runs a debug side effect at import
// time (reads a bundled test PDF), so the AccessPay parser imports the
// inner module directly via `pdf-parse/lib/pdf-parse.js`. `@types/pdf-parse`
// only ships types for the package's main entry, not that subpath, so we
// declare it here to keep the parser type-safe under strict tsc.
declare module "pdf-parse/lib/pdf-parse.js" {
  import pdfParse from "pdf-parse";
  export default pdfParse;
}
