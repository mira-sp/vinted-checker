// Pure helpers with no database or model access, so they are easy to test.

export type Method = "clip" | "phash" | "web-full" | "web-partial" | "web-page";

export type Match = {
  sourceName: string;
  sourceUrl: string | null;
  /**
   * A real 0..1 score for local checks (CLIP cosine similarity, pHash bit overlap).
   * Null for web results: Google gives no score, only the kind of match.
   */
  similarity: number | null;
  method: Method;
  /** Which of the checked photos (0-based) this match came from. */
  image?: number;
};

export type Verdict = "likely_fast_fashion" | "possible_fast_fashion" | "no_match_found";

/**
 * Fast-fashion shops. `labels` match the shop's own domain name (shein.com,
 * de.shein.com, shein.co.uk). `cdns` match a hostname suffix and catch image
 * hosts, which is where reverse image search usually lands.
 */
export const SOURCES: { name: string; labels: string[]; cdns: string[] }[] = [
  { name: "Shein", labels: ["shein", "sheinside", "romwe"], cdns: ["ltwebstatic.com", "sheinside.com"] },
  { name: "Temu", labels: ["temu"], cdns: ["kwcdn.com"] },
  { name: "AliExpress", labels: ["aliexpress"], cdns: ["alicdn.com"] },
  { name: "Zaful", labels: ["zaful"], cdns: [] },
  { name: "Cider", labels: ["shopcider"], cdns: [] },
  { name: "DHgate", labels: ["dhgate"], cdns: ["dhresource.com"] },
  { name: "Wish", labels: ["wish"], cdns: [] },
];

/**
 * True when `label` is the registrable name of `host`, i.e. every label after it
 * is a short public suffix part such as "com", "co", "uk" or "de".
 * Matches "de.shein.com" and "shein.co.uk", but not "wish.example.org" or
 * "temu.blogspot.com", where the name is only a subdomain of someone else's site.
 */
function isDomainName(labels: string[], label: string): boolean {
  const i = labels.lastIndexOf(label);
  if (i < 0) return false;
  const rest = labels.slice(i + 1);
  return rest.length >= 1 && rest.length <= 2 && rest.every((l) => l.length <= 3);
}

export function sourceForUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split(".");
  for (const s of SOURCES) {
    if (s.labels.some((l) => isDomainName(labels, l))) return s.name;
    if (s.cdns.some((c) => host === c || host.endsWith("." + c))) return s.name;
  }
  return null;
}

/** Number of differing positions between two equal-length bit strings. */
export function hamming(a: string, b: string): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  return d + Math.abs(a.length - b.length);
}

/** Lower rank = stronger evidence. Used to order matches of different kinds. */
const METHOD_RANK: Record<Method, number> = {
  phash: 0,
  "web-full": 1,
  clip: 2,
  "web-partial": 3,
  "web-page": 4,
};

/** Strong signals: each one alone is enough for "likely". */
const STRONG = new Set<Method>(["phash", "web-full", "clip"]);

/**
 * De-duplicate by source + url (keeping the strongest), then order by kind of
 * evidence first and score second. Scores of different methods are not
 * comparable, so they are never sorted against each other directly.
 */
export function mergeMatches(all: Match[], limit = 20): Match[] {
  const better = (a: Match, b: Match) =>
    METHOD_RANK[a.method] - METHOD_RANK[b.method] || (b.similarity ?? 0) - (a.similarity ?? 0);

  const best = new Map<string, Match>();
  for (const m of all) {
    const k = `${m.sourceName}|${m.sourceUrl ?? ""}`;
    const prev = best.get(k);
    if (!prev || better(m, prev) < 0) best.set(k, m);
  }
  return [...best.values()].sort(better).slice(0, limit);
}

/**
 * "likely" needs one strong signal (near-identical copy, exact web match, or a
 * CLIP match above threshold) or two different kinds of weak web evidence.
 * A single page whose domain looks like a shop is only "possible".
 */
export function verdictFor(matches: Match[]): Verdict {
  if (!matches.length) return "no_match_found";
  if (matches.some((m) => STRONG.has(m.method))) return "likely_fast_fashion";
  const kinds = new Set(matches.map((m) => m.method));
  return kinds.size >= 2 ? "likely_fast_fashion" : "possible_fast_fashion";
}
