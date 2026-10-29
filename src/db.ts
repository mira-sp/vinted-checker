import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";

mkdirSync("data", { recursive: true });

export const db = new Database("data/checker.db");

db.pragma("journal_mode = WAL");

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

  -- Images you already know come from a fast-fashion shop.
  -- Every confirmed hit can be saved here so the next check is instant.
  CREATE TABLE IF NOT EXISTS reference_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_name TEXT NOT NULL,
    source_url TEXT,
    phash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// CLIP embedding (512 float32s as a BLOB). Older databases don't have the column yet.
try {
  db.exec("ALTER TABLE reference_images ADD COLUMN embedding BLOB");
} catch {
  // column already exists
}