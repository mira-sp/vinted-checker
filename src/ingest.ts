// Usage: npm run ingest -- <folder> <SourceName>
// Example: npm run ingest -- ./refs/shein Shein
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { db } from "./db.js";
import { embedImage, vectorToBlob } from "./embeddings.js";
import { hashImage, normalize } from "./matching.js";

const [folder, sourceName] = process.argv.slice(2);
if (!folder || !sourceName) {
  console.error("Usage: npm run ingest -- <folder> <SourceName>");
  process.exit(1);
}

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);
const files = (await readdir(folder)).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()));

const insert = db.prepare(
  "INSERT INTO reference_images (source_name, source_url, phash, embedding) VALUES (?, ?, ?, ?)"
);

let done = 0;
let failed = 0;
for (const file of files) {
  try {
    const buffer = await normalize(await readFile(join(folder, file)));
    const hash = await hashImage(buffer);
    const embedding = vectorToBlob(await embedImage(buffer));
    insert.run(sourceName, null, hash, embedding);
    done++;
    if (done % 25 === 0) console.log(`${done}/${files.length}`);
  } catch (err) {
    failed++;
    console.warn(`Skipped ${file}: ${(err as Error).message}`);
  }
}

console.log(`Added ${done} ${sourceName} reference images${failed ? `, ${failed} skipped` : ""}.`);