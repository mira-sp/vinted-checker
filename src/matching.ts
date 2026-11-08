import type { FastifyBaseLogger } from "fastify";
import { db } from "./db.js";
import { activeModel, embedImage, embeddedCount, nearest, type ModelName } from "./embeddings.js";
import { crops, hashImage } from "./images.js";
import { hamming, mergeMatches, sourceForUrl, verdictFor, type Match, type Verdict } from "./sources.js";

export type { Match } from "./sources.js";
export { hashImage, normalize } from "./images.js";

export type OnlineFinding = {
  title: string;
  url: string | null;
  type: "page" | "image" | "entity";
  sourceName: string | null;
  /** Which of the checked photos (0-based) this came from. */
  image?: number;
};

export type WebInfo = {
  pages: number;
  images: number;
  entities: { description: string; score: number }[];
};

type WebStatus = "used" | "cached" | "disabled" | "failed";
type ClipStatus = "used" | "no_references" | "failed";
type Closest = { sourceName: string; score: number; image?: number } | null;

/** Result for one photo of a multi-photo check. */
export type ImageResult = {
  index: number;
  verdict: Verdict;
  matchCount: number;
  closest: Closest;
};

export type CheckResult = {
  /** Combined verdict over all photos. */
  verdict: Verdict;
  matches: Match[];
  /** "cached" when every photo's Google result came from the local cache. */
  webSearch: WebStatus;
  /** "no_references" when nothing has been ingested yet; "failed" if the model could not load. */
  clip: ClipStatus;
  /** The embedding model used for the visual check. */
  model: ModelName;
  onlineFindings: OnlineFinding[];
  web: WebInfo | null;
  /** Best visual score against any reference, even below the threshold. Useful for tuning. */
  closest: Closest;
  images: ImageResult[];
};

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

/** Embeds a photo and its crops (see `crops`). Used for checks and by `npm run eval`. */
export async function embedWithCrops(buffer: Buffer, model: ModelName = activeModel()): Promise<Float32Array[]> {
  const vectors: Float32Array[] = [];
  for (const img of await crops(buffer)) vectors.push(await embedImage(img, model));
  return vectors;
}

/** Minimum visual similarity that counts as "same product". Tune with `npm run eval`. */
export function clipThreshold(): number {
  return Number(process.env.CLIP_THRESHOLD ?? 0.88);
}

async function clipMatches(
  buffer: Buffer,
  log: FastifyBaseLogger,
): Promise<{ matches: Match[]; status: ClipStatus; closest: Closest }> {
  try {
    if (embeddedCount() === 0) return { matches: [], status: "no_references", closest: null };
    const neighbours = nearest(await embedWithCrops(buffer), 5);
    const threshold = clipThreshold();
    return {
      status: "used",
      matches: neighbours
        .filter((n) => n.score >= threshold)
        .map((n) => ({
          sourceName: n.sourceName,
          sourceUrl: n.sourceUrl,
          similarity: n.score,
          method: "clip" as const,
        })),
      closest: neighbours[0] ? { sourceName: neighbours[0].sourceName, score: neighbours[0].score } : null,
    };
  } catch (err) {
    log.error({ err }, "Visual check failed; continuing without it");
    return { matches: [], status: "failed", closest: null };
  }
}

type VisionImage = { url?: string };
type VisionPage = { url?: string; pageTitle?: string };
type VisionEntity = { description?: string; score?: number };
type WebDetection = {
  fullMatchingImages?: VisionImage[];
  partialMatchingImages?: VisionImage[];
  pagesWithMatchingImages?: VisionPage[];
  webEntities?: VisionEntity[];
};
type VisionResponse = { responses?: { webDetection?: WebDetection; error?: { message: string } }[] };

type WebResult = { matches: Match[]; findings: OnlineFinding[]; status: WebStatus; info: WebInfo | null };

export function webSearchEnabled(): boolean {
  return Boolean(process.env.GOOGLE_VISION_API_KEY);
}

const VISION_TIMEOUT_MS = 15_000;
// Results for a photo change slowly; reuse them for this long before asking Google again.
const VISION_CACHE_DAYS = 30;

const getCached = db.prepare(
  `SELECT response_json FROM vision_cache WHERE phash = ? AND created_at > datetime('now', ?)`,
);
const putCached = db.prepare(
  "INSERT OR REPLACE INTO vision_cache (phash, response_json, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
);

/** Turns Google's web detection into matches (known shops only) and raw findings. */
function parseWebDetection(web: WebDetection): Omit<WebResult, "status"> {
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

  return { matches, findings: findings.slice(0, 30), info };
}

/**
 * Google Cloud Vision "web detection" accepts the image itself (base64),
 * so it works from a local app with no public URL.
 * Set GOOGLE_VISION_API_KEY to enable it. Results are cached by perceptual
 * hash, so checking the same photo again doesn't cost another request.
 */
async function webMatches(buffer: Buffer, hash: string, log: FastifyBaseLogger): Promise<WebResult> {
  const key = process.env.GOOGLE_VISION_API_KEY;
  const failed: WebResult = { matches: [], findings: [], status: "failed", info: null };
  if (!key) return { ...failed, status: "disabled" };

  const cached = getCached.get(hash, `-${VISION_CACHE_DAYS} days`) as { response_json: string } | undefined;
  if (cached) return { ...parseWebDetection(JSON.parse(cached.response_json)), status: "cached" };

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

    putCached.run(hash, JSON.stringify(web));
    return { ...parseWebDetection(web), status: "used" };
  } catch (err) {
    log.error({ err }, "Google Vision request failed");
    return failed;
  }
}

async function checkOne(buffer: Buffer, index: number, log: FastifyBaseLogger) {
  const hash = await hashImage(buffer);
  const local = localMatches(hash);
  // The web request and the visual check are independent, so run them together.
  const [web, clip] = await Promise.all([webMatches(buffer, hash, log), clipMatches(buffer, log)]);
  const tag = <T extends object>(x: T) => ({ ...x, image: index });
  const matches = [...local, ...clip.matches, ...web.matches].map(tag);
  return {
    matches,
    web: { ...web, findings: web.findings.map(tag) },
    clip: { ...clip, closest: clip.closest && tag(clip.closest) },
  };
}

/** Combines per-photo statuses: the most informative one wins. */
function combineStatus<T extends string>(statuses: T[], order: T[]): T {
  return order.find((s) => statuses.includes(s)) ?? statuses[0]!;
}

function combineWebInfo(infos: (WebInfo | null)[]): WebInfo | null {
  const present = infos.filter((i): i is WebInfo => i !== null);
  if (!present.length) return null;
  const entities = new Map<string, number>();
  for (const e of present.flatMap((i) => i.entities)) {
    entities.set(e.description, Math.max(entities.get(e.description) ?? 0, e.score));
  }
  return {
    pages: present.reduce((n, i) => n + i.pages, 0),
    images: present.reduce((n, i) => n + i.images, 0),
    entities: [...entities]
      .map(([description, score]) => ({ description, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8),
  };
}

/**
 * Checks one or more photos of the same listing. Each photo is checked on its
 * own; the verdict and matches are combined, since often only one photo (the
 * label, a flat lay) matches a shop image.
 */
export async function checkImages(buffers: Buffer[], log: FastifyBaseLogger): Promise<CheckResult> {
  const results = [];
  // One at a time: the visual model already uses all CPU cores.
  for (const [i, buffer] of buffers.entries()) results.push(await checkOne(buffer, i, log));

  const matches = mergeMatches(results.flatMap((r) => r.matches));
  const closest = results
    .map((r) => r.clip.closest)
    .reduce<Closest>((best, c) => (c && (!best || c.score > best.score) ? c : best), null);

  return {
    verdict: verdictFor(matches),
    matches,
    webSearch: combineStatus(
      results.map((r) => r.web.status),
      ["used", "cached", "failed", "disabled"],
    ),
    clip: combineStatus(
      results.map((r) => r.clip.status),
      ["used", "failed", "no_references"],
    ),
    model: activeModel(),
    onlineFindings: results.flatMap((r) => r.web.findings).slice(0, 30),
    web: combineWebInfo(results.map((r) => r.web.info)),
    closest,
    images: results.map((r, index) => ({
      index,
      verdict: verdictFor(r.matches),
      matchCount: mergeMatches(r.matches).length,
      closest: r.clip.closest,
    })),
  };
}
