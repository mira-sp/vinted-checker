// Usage: npm run reembed [-- --model <name>]
//
// Computes embeddings for every reference that doesn't have one for the model
// yet (default: EMBEDDING_MODEL, or clip). Run it after switching models.
//
// References saved before photos were kept have no stored photo. For those,
// the photo is looked up by its perceptual hash in data/uploads/ and refs/.
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { UPLOADS_DIR, db } from "./db.js";
import { activeModel, isModelName, MODELS, type ModelName } from "./embeddings.js";
import { hashImage, normalize } from "./images.js";
import { attachPhoto, embedReference, referencesMissing, type ReferenceRow } from "./references.js";

function parseModel(): ModelName {
  const i = process.argv.indexOf("--model");
  const name = i >= 0 ? process.argv[i + 1] : activeModel();
  if (!name || !isModelName(name)) {
    console.error(`Unknown model "${name}". Use one of: ${Object.keys(MODELS).join(", ")}.`);
    process.exit(1);
  }
  return name;
}

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);

async function imageFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true });
    return entries.filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Finds stored photos for references that don't have one, by matching perceptual hashes. */
async function recoverPhotos(): Promise<number> {
  const missing = db.prepare("SELECT * FROM reference_images WHERE image_path IS NULL").all() as ReferenceRow[];
  if (!missing.length) return 0;
  const wanted = new Map<string, ReferenceRow[]>();
  for (const r of missing) wanted.set(r.phash, [...(wanted.get(r.phash) ?? []), r]);

  let recovered = 0;
  // Uploads are stored already normalized; files in refs/ were normalized before hashing by ingest.
  const sources: [string[], boolean][] = [
    [await imageFiles(UPLOADS_DIR), false],
    [await imageFiles("refs"), true],
  ];
  for (const [files, needsNormalize] of sources) {
    for (const file of files) {
      if (!wanted.size) return recovered;
      try {
        const raw = await readFile(file);
        const buffer = needsNormalize ? await normalize(raw) : raw;
        const rows = wanted.get(await hashImage(buffer));
        if (!rows) continue;
        for (const r of rows) await attachPhoto(r.id, buffer);
        recovered += rows.length;
        wanted.delete(rows[0]!.phash);
      } catch {
        // unreadable file: skip
      }
    }
  }
  return recovered;
}

const model = parseModel();
const recovered = await recoverPhotos();
if (recovered) console.log(`Recovered stored photos for ${recovered} older references.`);

const todo = referencesMissing(model);
const withPhoto = todo.filter((r) => r.image_path);
const withoutPhoto = todo.filter((r) => !r.image_path);
console.log(`${withPhoto.length} references need a ${model} embedding.`);

let done = 0;
let failed = 0;
for (const row of withPhoto) {
  try {
    await embedReference(row, model);
    done++;
  } catch (err) {
    failed++;
    console.warn(`Reference ${row.id} (${row.source_name}): ${(err as Error).message}`);
  }
  if ((done + failed) % 10 === 0) console.log(`${done + failed}/${withPhoto.length}`);
}

console.log(`Embedded ${done} references with ${model}${failed ? `, ${failed} failed` : ""}.`);
if (withoutPhoto.length) {
  console.log(
    `${withoutPhoto.length} references have no stored photo and can't be embedded ` +
      `(ids ${withoutPhoto.map((r) => r.id).join(", ")}). Add them again, or delete them on the References page.`,
  );
}
