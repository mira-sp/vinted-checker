import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";

/** Where the database and uploads live. Tests point this at a temporary folder. */
export const DATA_DIR = process.env.DATA_DIR || "data";

/** Photos of checked listings. */
export const UPLOADS_DIR = `${DATA_DIR}/uploads`;
/** Photos saved as references. */
export const REFERENCE_IMAGES_DIR = `${DATA_DIR}/reference`;

for (const dir of [DATA_DIR, UPLOADS_DIR, REFERENCE_IMAGES_DIR]) mkdirSync(dir, { recursive: true });

export const db = new Database(`${DATA_DIR}/checker.db`);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/**
 * Schema migrations. Each entry runs once, in order; `PRAGMA user_version`
 * records how many have been applied. Only ever append to this list.
 */
const migrations: ((db: Database.Database) => void)[] = [
  // 1: base tables. Uses IF NOT EXISTS because databases created before
  // versioning already have them.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT,
        title TEXT,
        price REAL,
        image_path TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id INTEGER NOT NULL,
        source_name TEXT NOT NULL,
        source_url TEXT,
        similarity REAL,
        FOREIGN KEY (listing_id) REFERENCES listings(id)
      );

      -- Images known to come from a fast-fashion shop.
      CREATE TABLE IF NOT EXISTS reference_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_name TEXT NOT NULL,
        source_url TEXT,
        phash TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const cols = db.prepare("PRAGMA table_info(reference_images)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "embedding")) {
      // CLIP embedding: 512 float32s as a BLOB.
      db.exec("ALTER TABLE reference_images ADD COLUMN embedding BLOB");
    }
  },

  // 2: record how each match was found, index lookups by listing, and stop
  // the same reference image being stored twice for the same shop.
  (db) => {
    db.exec(`
      ALTER TABLE matches ADD COLUMN method TEXT;
      CREATE INDEX IF NOT EXISTS idx_matches_listing ON matches(listing_id);

      DELETE FROM reference_images
      WHERE id NOT IN (SELECT MIN(id) FROM reference_images GROUP BY source_name, phash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reference_unique ON reference_images(source_name, phash);
    `);
  },

  // 3: keep the full check result (JSON), so a past check can be shown again.
  (db) => {
    db.exec("ALTER TABLE listings ADD COLUMN result_json TEXT");
  },

  // 4: several photos per listing, embeddings per model, stored reference
  // photos (so they can be shown and re-embedded), and a Google Vision cache.
  (db) => {
    db.exec(`
      CREATE TABLE listing_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        image_path TEXT NOT NULL
      );
      CREATE INDEX idx_listing_images_listing ON listing_images(listing_id);
      INSERT INTO listing_images (listing_id, position, image_path)
        SELECT id, 0, image_path FROM listings WHERE image_path IS NOT NULL;

      -- One vector per reference and model, so models can be compared and switched.
      CREATE TABLE embeddings (
        reference_id INTEGER NOT NULL REFERENCES reference_images(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (reference_id, model)
      );
      INSERT INTO embeddings (reference_id, model, vector)
        SELECT id, 'clip', embedding FROM reference_images WHERE embedding IS NOT NULL;
      ALTER TABLE reference_images DROP COLUMN embedding;
      ALTER TABLE reference_images ADD COLUMN image_path TEXT;

      -- Google Vision web detection results, keyed by the image's perceptual hash.
      CREATE TABLE vision_cache (
        phash TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
  },
];

const current = db.pragma("user_version", { simple: true }) as number;
for (let v = current; v < migrations.length; v++) {
  db.transaction(() => {
    migrations[v]!(db);
    db.pragma(`user_version = ${v + 1}`);
  })();
}
