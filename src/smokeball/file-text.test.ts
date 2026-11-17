import { describe, expect, it } from 'vitest';
import { extractText, isUnreadableBinary } from './file-text.js';

const enc = (s: string) => new TextEncoder().encode(s);
const utf16 = (s: string) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    b[i * 2] = s.charCodeAt(i) & 0xff;
    b[i * 2 + 1] = s.charCodeAt(i) >> 8;
  }
  return b;
};

describe('extractText (real matter files are not all text)', () => {
  it('plain text passes through', () => {
    expect(extractText(enc('NYSIF lien in the amount of $97,000.00.'))).toContain('$97,000.00');
  });
  it('PDF, zip/docx, and images yield nothing — never garbage', () => {
    expect(extractText(enc('%PDF-1.7\n1 0 obj << /Length 44 >> stream $5,000 endstream'))).toBe('');
    expect(extractText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]))).toBe('');
    expect(isUnreadableBinary(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isUnreadableBinary(new Uint8Array(512).fill(1))).toBe(true);
  });
  it('recovers the body and attachment name from an Outlook .msg container', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const pad = new Uint8Array(504).fill(0);
    const body = utf16('Kevin - the package is at https://www.dropbox.com/s/abc/pkg.pdf Please confirm receipt.');
    const gap = new Uint8Array([0, 0, 1, 0, 2, 0, 0, 0]);
    const att = utf16('Settlement Package - Grasso.pdf');
    const bytes = new Uint8Array([...ole, ...pad, ...body, ...gap, ...att, ...gap]);
    expect(isUnreadableBinary(bytes.subarray(0, 2048))).toBe(false);
    const text = extractText(bytes);
    expect(text).toMatch(/dropbox\.com/);
    expect(text).toContain('Settlement Package - Grasso.pdf');
  });
  it('strips HTML email bodies', () => {
    const t = extractText(enc('<html><body><p>Offer is <b>$45,000</b></p><style>p{color:red}</style></body></html>'));
    expect(t).toContain('$45,000');
    expect(t).not.toMatch(/<b>|color:red/);
  });
});
