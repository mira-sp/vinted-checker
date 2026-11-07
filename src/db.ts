import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";

/** Where the database and uploads live. Tests point this at a temporary folder. */
export const DATA_DIR = process.env.DATA_DIR || "data";

mkdirSync(DATA_DIR, { recursive: true });

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
];

const current = db.pragma("user_version", { simple: true }) as number;
for (let v = current; v < migrations.length; v++) {
  db.transaction(() => {
    migrations[v]!(db);
    db.pragma(`user_version = ${v + 1}`);
  })();
}

/** Inserts a reference image. Returns false if this shop already has the same image. */
const insertReference = db.prepare(
  `INSERT OR IGNORE INTO reference_images (source_name, source_url, phash, embedding)
   VALUES (?, ?, ?, ?)`,
);

export function saveReference(sourceName: string, sourceUrl: string | null, phash: string, embedding: Buffer): boolean {
  return insertReference.run(sourceName, sourceUrl, phash, embedding).changes > 0;
}
