import sharp from "sharp";
import phash from "sharp-phash";
import { db } from "./db.js";
import { embedImage, nearest } from "./embeddings.js";

export type Match = {
  sourceName: string;
  sourceUrl: string | null;
  similarity: number; // 0..1
  method: "clip" | "phash" | "web-full" | "web-partial" | "web-page";
};

export type CheckResult = {
  verdict: "likely_fast_fashion" | "no_match_found";
  matches: Match[];
  webSearch: "used" | "disabled" | "failed";
  /** Best CLIP score against any reference, even below the threshold. Useful for tuning. */
  closest: { sourceName: string; score: number } | null;
};

/**
 * Fast-fashion shops. `labels` match a hostname label (shein.com, de.shein.com,
 * shein.co.uk all contain the label "shein"). `cdns` match a hostname suffix
 * and catch image hosts, which is where reverse image search usually lands.
 */
const SOURCES: { name: string; labels: string[]; cdns: string[] }[] = [
  { name: "Shein", labels: ["shein", "sheinside", "romwe"], cdns: ["ltwebstatic.com", "sheinside.com"] },
  { name: "Temu", labels: ["temu"], cdns: ["kwcdn.com"] },
  { name: "AliExpress", labels: ["aliexpress"], cdns: ["alicdn.com"] },
  { name: "Zaful", labels: ["zaful"], cdns: [] },
  { name: "Cider", labels: ["shopcider"], cdns: [] },
  { name: "DHgate", labels: ["dhgate"], cdns: ["dhresource.com"] },
  { name: "Wish", labels: ["wish"], cdns: [] },
];

function sourceForUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split(".");
  for (const s of SOURCES) {
    if (s.labels.some((l) => labels.includes(l))) return s.name;
    if (s.cdns.some((c) => host === c || host.endsWith("." + c))) return s.name;
  }
  return null;
}

/** Fix rotation, shrink, and re-encode so hashing and uploads are consistent. */
export async function normalize(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

export async function hashImage(buffer: Buffer): Promise<string> {
  return phash(buffer); // 64-char string of 0/1
}

function hamming(a: string, b: string): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  return d;
}

// 0-10 differing bits out of 64 is a near-identical image.
const PHASH_MAX_DISTANCE = 10;

function localMatches(hash: string): Match[] {
  const rows = db
    .prepare("SELECT source_name, source_url, phash FROM reference_images")
    .all() as { source_name: string; source_url: string | null; phash: string }[];

  const out: Match[] = [];
  for (const r of rows) {
    const d = hamming(hash, r.phash);
    if (d <= PHASH_MAX_DISTANCE) {
      out.push({
        sourceName: r.source_name,
        sourceUrl: r.source_url,
        similarity: 1 - d / 64,
        method: "phash",
      });
    }
  }
  return out;
}

type VisionImage = { url?: string };
type VisionResponse = {
  responses?: {
    webDetection?: {
      fullMatchingImages?: VisionImage[];
      partialMatchingImages?: VisionImage[];
      pagesWithMatchingImages?: VisionImage[];
    };
    error?: { message: string };
  }[];
};

/**
 * Google Cloud Vision "web detection" accepts the image itself (base64),
 * so it works from a local app with no public URL.
 * Set GOOGLE_VISION_API_KEY to enable it.
 */
async function webMatches(buffer: Buffer): Promise<{ matches: Match[]; status: CheckResult["webSearch"] }> {
  const key = process.env.GOOGLE_VISION_API_KEY;
  if (!key) return { matches: [], status: "disabled" };

  try {
    const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: buffer.toString("base64") },
            features: [{ type: "WEB_DETECTION", maxResults: 50 }],
          },
        ],
      }),
    });
    if (!res.ok) return { matches: [], status: "failed" };

    const data = (await res.json()) as VisionResponse;
    const web = data.responses?.[0]?.webDetection;
    if (!web) return { matches: [], status: "failed" };

    const groups: [VisionImage[] | undefined, Match["method"], number][] = [
      [web.fullMatchingImages, "web-full", 0.95],
      [web.partialMatchingImages, "web-partial", 0.75],
      [web.pagesWithMatchingImages, "web-page", 0.7],
    ];

    const out: Match[] = [];
    for (const [items, method, similarity] of groups) {
      for (const item of items ?? []) {
        if (!item.url) continue;
        const name = sourceForUrl(item.url);
        if (name) out.push({ sourceName: name, sourceUrl: item.url, similarity, method });
      }
    }
    return { matches: out, status: "used" };
  } catch {
    return { matches: [], status: "failed" };
  }
}

// Cosine similarity at or above this counts as "same product". The right value
// depends on your references: check `closest` on real examples, then adjust.
const CLIP_THRESHOLD = Number(process.env.CLIP_THRESHOLD ?? 0.88);

export async function checkImage(buffer: Buffer): Promise<CheckResult> {
  const hash = await hashImage(buffer);

  const local = localMatches(hash);
  const web = await webMatches(buffer);

  const neighbours = nearest(await embedImage(buffer), 5);
  const clip: Match[] = neighbours
    .filter((n) => n.score >= CLIP_THRESHOLD)
    .map((n) => ({ sourceName: n.sourceName, sourceUrl: n.sourceUrl, similarity: n.score, method: "clip" as const }));

  // De-duplicate by source + url, keep the highest similarity, sort best first.
  const best = new Map<string, Match>();
  for (const m of [...local, ...clip, ...web.matches]) {
    const k = `${m.sourceName}|${m.sourceUrl ?? ""}`;
    const prev = best.get(k);
    if (!prev || m.similarity > prev.similarity) best.set(k, m);
  }
  const matches = [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, 20);

  return {
    verdict: matches.length ? "likely_fast_fashion" : "no_match_found",
    matches,
    webSearch: web.status,
    closest: neighbours[0] ? { sourceName: neighbours[0].sourceName, score: neighbours[0].score } : null,
  };
}