import sharp from "sharp";
import phash from "sharp-phash";
import type { FastifyBaseLogger } from "fastify";
import { db } from "./db.js";
import { embedImage, nearest, referenceCount } from "./embeddings.js";
import { hamming, mergeMatches, sourceForUrl, verdictFor, type Match, type Verdict } from "./sources.js";

export type { Match } from "./sources.js";

export type OnlineFinding = {
  title: string;
  url: string | null;
  type: "page" | "image" | "entity";
  sourceName: string | null;
};

export type WebInfo = {
  pages: number;
  images: number;
  entities: { description: string; score: number }[];
};

export type CheckResult = {
  verdict: Verdict;
  matches: Match[];
  webSearch: "used" | "disabled" | "failed";
  /** "no_references" when nothing has been ingested yet; "failed" if the model could not load. */
  clip: "used" | "no_references" | "failed";
  onlineFindings: OnlineFinding[];
  web: WebInfo | null;
  /** Best CLIP score against any reference, even below the threshold. Useful for tuning. */
  closest: { sourceName: string; score: number } | null;
};

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

// 0-10 differing bits out of 64 is a near-identical image.
const PHASH_MAX_DISTANCE = 10;

const allHashes = db.prepare("SELECT source_name, source_url, phash FROM reference_images");

function localMatches(hash: string): Match[] {
  const rows = allHashes.all() as { source_name: string; source_url: string | null; phash: string }[];
  const out: Match[] = [];
  for (const r of rows) {
    const d = hamming(hash, r.phash);
    if (d <= PHASH_MAX_DISTANCE) {
      out.push({ sourceName: r.source_name, sourceUrl: r.source_url, similarity: 1 - d / 64, method: "phash" });
    }
  }
  return out;
}

/**
 * Vinted photos are often worn or laid out on a bed, while shop images are
 * studio shots. Besides the whole image, embed a centre crop and the top and
 * bottom halves, so a garment that fills only part of the frame can still match.
 */
async function crops(buffer: Buffer): Promise<Buffer[]> {
  const { width = 0, height = 0 } = await sharp(buffer).metadata();
  if (width < 64 || height < 64) return [buffer];
  const region = (left: number, top: number, w: number, h: number) =>
    sharp(buffer)
      .extract({ left: Math.round(left), top: Math.round(top), width: Math.round(w), height: Math.round(h) })
      .toBuffer();
  return [
    buffer,
    await region(width * 0.15, height * 0.15, width * 0.7, height * 0.7),
    await region(0, 0, width, height * 0.55),
    await region(0, height * 0.45, width, height * 0.55),
  ];
}

// Cosine similarity at or above this counts as "same product". The right value
// depends on your references: check `closest` on real examples, then adjust.
const CLIP_THRESHOLD = Number(process.env.CLIP_THRESHOLD ?? 0.88);

async function clipMatches(
  buffer: Buffer,
  log: FastifyBaseLogger,
): Promise<{ matches: Match[]; status: CheckResult["clip"]; closest: CheckResult["closest"] }> {
  try {
    if (referenceCount() === 0) return { matches: [], status: "no_references", closest: null };
    const vectors: Float32Array[] = [];
    for (const img of await crops(buffer)) vectors.push(await embedImage(img));
    const neighbours = nearest(vectors, 5);
    return {
      status: "used",
      matches: neighbours
        .filter((n) => n.score >= CLIP_THRESHOLD)
        .map((n) => ({
          sourceName: n.sourceName,
          sourceUrl: n.sourceUrl,
          similarity: n.score,
          method: "clip" as const,
        })),
      closest: neighbours[0] ? { sourceName: neighbours[0].sourceName, score: neighbours[0].score } : null,
    };
  } catch (err) {
    log.error({ err }, "CLIP check failed; continuing without it");
    return { matches: [], status: "failed", closest: null };
  }
}

type VisionImage = { url?: string };
type VisionPage = { url?: string; pageTitle?: string };
type VisionEntity = { description?: string; score?: number };

type VisionResponse = {
  responses?: {
    webDetection?: {
      fullMatchingImages?: VisionImage[];
      partialMatchingImages?: VisionImage[];
      pagesWithMatchingImages?: VisionPage[];
      webEntities?: VisionEntity[];
    };
    error?: { message: string };
  }[];
};

type WebResult = {
  matches: Match[];
  findings: OnlineFinding[];
  status: CheckResult["webSearch"];
  info: WebInfo | null;
};

export function webSearchEnabled(): boolean {
  return Boolean(process.env.GOOGLE_VISION_API_KEY);
}

const VISION_TIMEOUT_MS = 15_000;

/**
 * Google Cloud Vision "web detection" accepts the image itself (base64),
 * so it works from a local app with no public URL.
 * Set GOOGLE_VISION_API_KEY to enable it.
 */
async function webMatches(buffer: Buffer, log: FastifyBaseLogger): Promise<WebResult> {
  const key = process.env.GOOGLE_VISION_API_KEY;
  const failed: WebResult = { matches: [], findings: [], status: "failed", info: null };
  if (!key) return { ...failed, status: "disabled" };

  try {
    const res = await fetch("https://vision.googleapis.com/v1/images:annotate", {
      method: "POST",
      // Key in a header rather than the URL, so it doesn't end up in proxy or access logs.
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
      // Give up rather than leave the check hanging if Google doesn't answer.
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      body: JSON.stringify({
        requests: [
          {
            image: { content: buffer.toString("base64") },
            features: [{ type: "WEB_DETECTION", maxResults: 50 }],
          },
        ],
      }),
    });

    if (!res.ok) {
      log.error({ status: res.status, body: await res.text() }, "Google Vision HTTP error");
      return failed;
    }

    const data = (await res.json()) as VisionResponse;
    const response = data.responses?.[0];
    if (response?.error) {
      log.error({ error: response.error }, "Google Vision API error");
      return failed;
    }

    const web = response?.webDetection;
    if (!web) {
      log.error({ data }, "No webDetection returned");
      return failed;
    }

    const info: WebInfo = {
      pages: web.pagesWithMatchingImages?.length ?? 0,
      images: (web.fullMatchingImages?.length ?? 0) + (web.partialMatchingImages?.length ?? 0),
      entities: (web.webEntities ?? [])
        .filter((e) => e.description)
        .map((e) => ({ description: e.description!, score: e.score ?? 0 }))
        .slice(0, 8),
    };

    const linkFinding = (title: string, type: "page" | "image", url?: string): OnlineFinding => ({
      title,
      url: url ?? null,
      type,
      sourceName: url ? sourceForUrl(url) : null,
    });

    const findings: OnlineFinding[] = [
      ...(web.pagesWithMatchingImages ?? []).map((p) =>
        linkFinding(p.pageTitle || p.url || "Matching page", "page", p.url),
      ),
      ...(web.fullMatchingImages ?? []).map((i) => linkFinding("Exact matching image", "image", i.url)),
      ...(web.partialMatchingImages ?? []).map((i) => linkFinding("Partially matching image", "image", i.url)),
      ...(web.webEntities ?? []).map((e) => ({
        title: e.description || "Unlabeled visual entity",
        url: null,
        type: "entity" as const,
        sourceName: null,
      })),
    ];

    // Google gives no score for these, only the kind of match, so similarity is null.
    const groups: [{ url?: string }[] | undefined, Match["method"]][] = [
      [web.fullMatchingImages, "web-full"],
      [web.partialMatchingImages, "web-partial"],
      [web.pagesWithMatchingImages, "web-page"],
    ];
    const matches: Match[] = [];
    for (const [items, method] of groups) {
      for (const item of items ?? []) {
        const name = item.url ? sourceForUrl(item.url) : null;
        if (name) matches.push({ sourceName: name, sourceUrl: item.url!, similarity: null, method });
      }
    }

    return { matches, findings: findings.slice(0, 30), status: "used", info };
  } catch (err) {
    log.error({ err }, "Google Vision request failed");
    return failed;
  }
}

export async function checkImage(buffer: Buffer, log: FastifyBaseLogger): Promise<CheckResult> {
  const hash = await hashImage(buffer);
  const local = localMatches(hash);

  // The web request and the CLIP model are independent, so run them together.
  const [web, clip] = await Promise.all([webMatches(buffer, log), clipMatches(buffer, log)]);

  const matches = mergeMatches([...local, ...clip.matches, ...web.matches]);

  return {
    verdict: verdictFor(matches),
    matches,
    webSearch: web.status,
    clip: clip.status,
    onlineFindings: web.findings,
    web: web.info,
    closest: clip.closest,
  };
}
