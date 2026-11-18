/**
 * Names heard, not typed. Speech recognition turns "Grasso" into "grass oh",
 * "Okafor" into "oak a for", "Vasquez" into "Vasquez's". Exact matching then
 * finds nothing and PAM says "no such matter" about a client she has. These
 * helpers find the names a misheard one was probably meant to be.
 */

const squash = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/'s\b/g, '')
    .replace(/[^a-z]/g, '');

/** A rough "sounds like" key: vowels collapse, look-alike consonants merge. */
export function soundKey(name: string): string {
  let s = squash(name);
  s = s
    .replace(/ph/g, 'f')
    .replace(/tch|cc(?=[ie])|ch/g, 'x')
    .replace(/ck|q|c(?=[aou])|c$/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/z/g, 's')
    .replace(/v/g, 'f')
    .replace(/gh/g, 'g')
    .replace(/[wh]/g, '')
    .replace(/y/g, 'i');
  const head = s[0] ?? '';
  const tail = s
    .slice(1)
    .replace(/[aeiou]+/g, '')
    .replace(/(.)\1+/g, '$1');
  return (head + tail).replace(/(.)\1+/g, '$1');
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

/** 0 (nothing alike) … 1 (same). Spelling distance and sound both count. */
export function nameSimilarity(heard: string, actual: string): number {
  const a = squash(heard);
  const b = squash(actual);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const spell = 1 - editDistance(a, b) / Math.max(a.length, b.length);
  const ka = soundKey(heard);
  const kb = soundKey(actual);
  const sound = ka && kb ? 1 - editDistance(ka, kb) / Math.max(ka.length, kb.length) : 0;
  return Math.max(spell, sound * 0.92);
}

/** The candidates a misheard query most plausibly meant, best first. */
export function closestNames<T>(heard: string, items: T[], namesOf: (item: T) => string[], minScore = 0.72, max = 5): { item: T; score: number }[] {
  // "grass oh" may be one name split in two — try the words joined as well.
  const variants = [...new Set([heard, heard.replace(/\s+/g, ''), ...heard.split(/\s+/).filter((w) => w.length >= 3)])];
  return items
    .map((item) => ({
      item,
      score: Math.max(0, ...namesOf(item).flatMap((n) => (n ? variants.map((v) => nameSimilarity(v, n)) : [0]))),
    }))
    .filter((x) => x.score >= minScore)
    .sort((x, y) => y.score - x.score)
    .slice(0, max);
}
