/**
 * Turning a downloaded matter file into text PAM can read — safely.
 *
 * Real matters hold Outlook .msg emails (binary OLE containers), scanned
 * PDFs, Word files, and images. Decoding those as UTF-8 yields megabytes of
 * garbage that regexes then "match" by accident. So: sniff the first bytes,
 * read what is genuinely readable, and return '' for everything else.
 */

const startsWith = (b: Uint8Array, sig: number[]): boolean => sig.every((v, i) => b[i] === v);

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const UNREADABLE: number[][] = [
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x50, 0x4b, 0x03, 0x04], // zip (docx/xlsx/…)
  [0xff, 0xd8, 0xff], // jpeg
  [0x89, 0x50, 0x4e, 0x47], // png
  [0x47, 0x49, 0x46, 0x38], // gif
  [0x49, 0x49, 0x2a, 0x00], // tiff LE
  [0x4d, 0x4d, 0x00, 0x2a], // tiff BE
  [0x52, 0x61, 0x72, 0x21], // rar
  [0x1f, 0x8b], // gzip
];

/** True when the first chunk shows a format PAM cannot read as text — the
 *  caller should stop downloading immediately. */
export function isUnreadableBinary(head: Uint8Array): boolean {
  if (head.length === 0) return false;
  if (startsWith(head, OLE)) return false; // .msg — strings are recoverable
  if (UNREADABLE.some((sig) => startsWith(head, sig))) return true;
  // Unknown format: lots of control bytes means binary.
  const n = Math.min(head.length, 2048);
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const c = head[i]!;
    if (c === 0 || (c < 9 && c !== 0) || (c > 13 && c < 32)) odd++;
  }
  // UTF-16 text is half NULs — allow it when a BOM says so.
  const utf16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
  return !utf16 && odd / n > 0.1;
}

/** Printable runs from an OLE container (.msg): the subject, addresses,
 *  body, and attachment names are stored as UTF-16LE (modern) or ASCII. */
function oleStrings(b: Uint8Array): string {
  const out: string[] = [];
  const printable = (c: number) => (c >= 0x20 && c < 0x7f) || c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0xa0 && c <= 0x24f) || (c >= 0x2010 && c <= 0x2027);
  // UTF-16LE runs
  let run = '';
  for (let i = 0; i + 1 < b.length; i += 2) {
    const c = b[i]! | (b[i + 1]! << 8);
    if (printable(c)) {
      run += String.fromCharCode(c);
    } else {
      if (run.trim().length >= 6) out.push(run.trim());
      run = '';
    }
  }
  if (run.trim().length >= 6) out.push(run.trim());
  // ASCII runs (older non-Unicode messages, headers)
  run = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    if ((c >= 0x20 && c < 0x7f) || c === 0x0a || c === 0x0d || c === 0x09) {
      run += String.fromCharCode(c);
    } else {
      if (run.trim().length >= 10) out.push(run.trim());
      run = '';
    }
  }
  if (run.trim().length >= 10) out.push(run.trim());
  return out.join('\n');
}

const stripHtml = (s: string): string =>
  s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]{2,}/g, ' ');

/** Best-effort readable text; '' when the file is not text PAM can trust. */
export function extractText(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  if (startsWith(bytes, OLE)) return oleStrings(bytes);
  if (isUnreadableBinary(bytes.subarray(0, 2048))) return '';
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  else text = new TextDecoder('utf-8').decode(bytes);
  if (/<html|<body|<div|<p[\s>]/i.test(text.slice(0, 4000))) text = stripHtml(text);
  // Quoted-printable soft breaks (.eml)
  return text.replace(/=\r?\n/g, '');
}
