import { AutoProcessor, CLIPVisionModelWithProjection, RawImage, SiglipVisionModel } from "@huggingface/transformers";
import { db } from "./db.js";

/**
 * Image embedding models. Each is downloaded from the Hugging Face hub on
 * first use, then cached on disk. Embeddings from different models can't be
 * compared, so every stored vector records which model made it.
 */
export const MODELS = {
  // General-purpose CLIP. ~90 MB.
  clip: { hub: "Xenova/clip-vit-base-patch32", loader: CLIPVisionModelWithProjection, dtype: undefined },
  // Fine-tuned on fashion products (Apache-2.0). 8-bit vision model, ~94 MB.
  "fashion-siglip": { hub: "Marqo/marqo-fashionSigLIP", loader: SiglipVisionModel, dtype: "q8" },
} as const;

export type ModelName = keyof typeof MODELS;

export function isModelName(name: string): name is ModelName {
  return Object.hasOwn(MODELS, name);
}

/** The model used for checks, from EMBEDDING_MODEL (default: clip). */
export function activeModel(): ModelName {
  const name = process.env.EMBEDDING_MODEL || "clip";
  if (!isModelName(name)) {
    throw new Error(`Unknown EMBEDDING_MODEL "${name}". Use one of: ${Object.keys(MODELS).join(", ")}.`);
  }
  return name;
}

type Loaded = { processor: any; model: any };
const loading = new Map<ModelName, Promise<Loaded>>();

function getModel(name: ModelName): Promise<Loaded> {
  let p = loading.get(name);
  if (!p) {
    const { hub, loader, dtype } = MODELS[name];
    p = (async () => ({
      processor: await AutoProcessor.from_pretrained(hub),
      model: await loader.from_pretrained(hub, dtype ? { dtype } : {}),
    }))().catch((err) => {
      loading.delete(name); // don't cache the failure, so the next call can retry
      throw err;
    });
    loading.set(name, p);
  }
  return p;
}

/** Load the model now so the first check isn't slow. */
export async function warmUp(name: ModelName = activeModel()): Promise<void> {
  await getModel(name);
}

/** Returns a unit-length vector, so cosine similarity is a plain dot product. */
export async function embedImage(buffer: Buffer, name: ModelName = activeModel()): Promise<Float32Array> {
  const { processor, model } = await getModel(name);
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

type Ref = { id: number; sourceName: string; sourceUrl: string | null; vec: Float32Array };
const cache = new Map<ModelName, Ref[]>();
let cachedVersion = -1;

/** Call after changing references through this process so the next search sees it. */
export function invalidateReferences(): void {
  cache.clear();
}

const referencesFor = db.prepare(
  `SELECT r.id, r.source_name, r.source_url, e.vector
   FROM embeddings e JOIN reference_images r ON r.id = e.reference_id
   WHERE e.model = ?`,
);

function references(name: ModelName): Ref[] {
  // data_version changes whenever another connection (e.g. `npm run ingest`
  // while the server is running) commits a write, so reload in that case too.
  const version = db.pragma("data_version", { simple: true }) as number;
  if (version !== cachedVersion) {
    cache.clear();
    cachedVersion = version;
  }
  let refs = cache.get(name);
  if (!refs) {
    const rows = referencesFor.all(name) as {
      id: number;
      source_name: string;
      source_url: string | null;
      vector: Buffer;
    }[];
    refs = rows.map((r) => ({
      id: r.id,
      sourceName: r.source_name,
      sourceUrl: r.source_url,
      vec: blobToVector(r.vector),
    }));
    cache.set(name, refs);
  }
  return refs;
}

/** Number of references that have an embedding for this model. */
export function embeddedCount(name: ModelName = activeModel()): number {
  return references(name).length;
}

export type Neighbour = { referenceId: number; sourceName: string; sourceUrl: string | null; score: number };

/**
 * Brute-force cosine search. Fine into the tens of thousands of references.
 * Pass several query vectors (e.g. crops of one photo) and each reference is
 * scored by its best match against any of them.
 */
export function nearest(queries: Float32Array[], k = 5, name: ModelName = activeModel()): Neighbour[] {
  const scored: Neighbour[] = [];
  for (const r of references(name)) {
    let best = -Infinity;
    for (const q of queries) {
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += (q[i] ?? 0) * (r.vec[i] ?? 0);
      if (dot > best) best = dot;
    }
    scored.push({ referenceId: r.id, sourceName: r.sourceName, sourceUrl: r.sourceUrl, score: best });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}
