import { AutoProcessor, CLIPVisionModelWithProjection, RawImage } from "@huggingface/transformers";
import { db } from "./db.js";

// Downloaded from the Hugging Face hub on first run (~90 MB), then cached on disk.
const MODEL_ID = "Xenova/clip-vit-base-patch32";

let loading: Promise<{ processor: any; model: any }> | null = null;

function getModel() {
  loading ??= (async () => ({
    processor: await AutoProcessor.from_pretrained(MODEL_ID),
    model: await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID),
  }))().catch((err) => {
    loading = null; // don't cache the failure, so the next call can retry
    throw err;
  });
  return loading;
}

/** Load the model now so the first paste isn't slow. */
export async function warmUp(): Promise<void> {
  await getModel();
}

/** Returns a unit-length 512-dim vector, so cosine similarity is a plain dot product. */
export async function embedImage(buffer: Buffer): Promise<Float32Array> {
  const { processor, model } = await getModel();
  const image = await RawImage.fromBlob(new Blob([new Uint8Array(buffer)]));
  const inputs = await processor(image);
  const { image_embeds } = await model(inputs);

  const v = Float32Array.from(image_embeds.data as Float32Array);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function blobToVector(b: Buffer): Float32Array {
  // Copy so the Float32Array is 4-byte aligned regardless of where SQLite put the bytes.
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

type Ref = { sourceName: string; sourceUrl: string | null; vec: Float32Array };
let cache: Ref[] | null = null;

/** Call after inserting a reference so the next search sees it. */
export function invalidateReferences(): void {
  cache = null;
}

function references(): Ref[] {
  if (cache) return cache;
  const rows = db
    .prepare("SELECT source_name, source_url, embedding FROM reference_images WHERE embedding IS NOT NULL")
    .all() as { source_name: string; source_url: string | null; embedding: Buffer }[];
  cache = rows.map((r) => ({
    sourceName: r.source_name,
    sourceUrl: r.source_url,
    vec: blobToVector(r.embedding),
  }));
  return cache;
}

export type Neighbour = { sourceName: string; sourceUrl: string | null; score: number };

/** Brute-force cosine search. Fine into the tens of thousands of references. */
export function nearest(query: Float32Array, k = 5): Neighbour[] {
  const scored: Neighbour[] = [];
  for (const r of references()) {
    let dot = 0;
    for (let i = 0; i < query.length; i++) dot += (query[i] ?? 0) * (r.vec[i] ?? 0);
    scored.push({ sourceName: r.sourceName, sourceUrl: r.sourceUrl, score: dot });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}