// Reference images: photos known to come from a shop. Used by the server,
// `npm run ingest` and `npm run reembed`.
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { REFERENCE_IMAGES_DIR, db } from "./db.js";
import { activeModel, embedImage, invalidateReferences, vectorToBlob, type ModelName } from "./embeddings.js";
import { hashImage } from "./images.js";

export type ReferenceRow = {
  id: number;
  source_name: string;
  source_url: string | null;
  phash: string;
  image_path: string | null;
  created_at: string;
};

const findDuplicate = db.prepare("SELECT id FROM reference_images WHERE source_name = ? AND phash = ?");
const insertReference = db.prepare(
  "INSERT INTO reference_images (source_name, source_url, phash, image_path) VALUES (?, ?, ?, ?)",
);
const insertEmbedding = db.prepare("INSERT OR REPLACE INTO embeddings (reference_id, model, vector) VALUES (?, ?, ?)");

/**
 * Saves a normalized photo as a reference for `sourceName`, with an embedding
 * for the active model. Skips the work if this shop already has the same photo.
 */
export async function addReference(
  buffer: Buffer,
  sourceName: string,
  sourceUrl: string | null,
): Promise<{ status: "reference_saved" | "already_saved"; id: number }> {
  const hash = await hashImage(buffer);
  const existing = findDuplicate.get(sourceName, hash) as { id: number } | undefined;
  if (existing) return { status: "already_saved", id: existing.id };

  const model = activeModel();
  const vector = vectorToBlob(await embedImage(buffer, model));
  const path = `${REFERENCE_IMAGES_DIR}/${randomUUID()}.jpg`;
  await writeFile(path, buffer);

  const id = db.transaction(() => {
    const refId = Number(insertReference.run(sourceName, sourceUrl, hash, path).lastInsertRowid);
    insertEmbedding.run(refId, model, vector);
    return refId;
  })();
  invalidateReferences();
  return { status: "reference_saved", id };
}

const listAll = db.prepare(
  `SELECT r.*, (SELECT group_concat(model) FROM embeddings e WHERE e.reference_id = r.id) AS models
   FROM reference_images r
   WHERE (?1 IS NULL OR r.source_name = ?1)
   ORDER BY r.id DESC`,
);
const shopCounts = db.prepare(
  "SELECT source_name AS name, COUNT(*) AS count FROM reference_images GROUP BY source_name ORDER BY count DESC",
);

export function listReferences(shop: string | null) {
  const rows = listAll.all(shop) as (ReferenceRow & { models: string | null })[];
  return {
    shops: shopCounts.all() as { name: string; count: number }[],
    items: rows.map((r) => ({
      id: r.id,
      sourceName: r.source_name,
      sourceUrl: r.source_url,
      createdAt: r.created_at,
      imageUrl: r.image_path ? `/reference-images/${r.image_path.split("/").pop()}` : null,
      models: r.models ? r.models.split(",") : [],
    })),
  };
}

const getReference = db.prepare("SELECT * FROM reference_images WHERE id = ?");
const updateReferenceRow = db.prepare("UPDATE reference_images SET source_name = ?, source_url = ? WHERE id = ?");
const deleteReferenceRow = db.prepare("DELETE FROM reference_images WHERE id = ?");

/** Changes a reference's shop or link. Returns "conflict" if the shop already has this photo. */
export function updateReference(
  id: number,
  changes: { sourceName?: string; sourceUrl?: string | null },
): "updated" | "not_found" | "conflict" {
  const row = getReference.get(id) as ReferenceRow | undefined;
  if (!row) return "not_found";
  const sourceName = changes.sourceName ?? row.source_name;
  const sourceUrl = changes.sourceUrl !== undefined ? changes.sourceUrl : row.source_url;
  const dupe = findDuplicate.get(sourceName, row.phash) as { id: number } | undefined;
  if (dupe && dupe.id !== id) return "conflict";
  updateReferenceRow.run(sourceName, sourceUrl, id);
  invalidateReferences();
  return "updated";
}

/** Deletes a reference, its embeddings and its stored photo. */
export async function deleteReference(id: number): Promise<boolean> {
  const row = getReference.get(id) as ReferenceRow | undefined;
  if (!row) return false;
  deleteReferenceRow.run(id); // embeddings go with it (ON DELETE CASCADE)
  invalidateReferences();
  if (row.image_path) await unlink(row.image_path).catch(() => {});
  return true;
}

const missingEmbedding = db.prepare(
  `SELECT * FROM reference_images r
   WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.reference_id = r.id AND e.model = ?)`,
);

/** References that have no embedding for `model` yet. */
export function referencesMissing(model: ModelName): ReferenceRow[] {
  return missingEmbedding.all(model) as ReferenceRow[];
}

/** Computes and stores the embedding of one stored reference photo for `model`. */
export async function embedReference(row: ReferenceRow, model: ModelName): Promise<void> {
  if (!row.image_path) throw new Error("no stored photo");
  const vector = vectorToBlob(await embedImage(await readFile(row.image_path), model));
  insertEmbedding.run(row.id, model, vector);
}

const setImagePath = db.prepare("UPDATE reference_images SET image_path = ? WHERE id = ?");

/** Stores a recovered photo for a reference that was saved before photos were kept. */
export async function attachPhoto(id: number, buffer: Buffer): Promise<void> {
  const path = `${REFERENCE_IMAGES_DIR}/${randomUUID()}.jpg`;
  await writeFile(path, buffer);
  setImagePath.run(path, id);
}
