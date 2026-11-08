// Usage: npm run ingest -- <folder> <SourceName>
// Example: npm run ingest -- ./refs/shein Shein
//
// Optional: put a `sources.csv` in the folder with lines `filename,url` to
// record where each image came from. Images already stored for this shop are skipped.
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { normalize } from "./images.js";
import { addReference } from "./references.js";

const [folder, sourceName] = process.argv.slice(2);
if (!folder || !sourceName) {
  console.error("Usage: npm run ingest -- <folder> <SourceName>");
  process.exit(1);
}

async function readSourceUrls(dir: string): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  try {
    const csv = await readFile(join(dir, "sources.csv"), "utf8");
    for (const line of csv.split(/\r?\n/)) {
      const comma = line.indexOf(",");
      if (comma > 0) urls.set(line.slice(0, comma).trim(), line.slice(comma + 1).trim());
    }
  } catch {
    // no sources.csv, which is fine
  }
  return urls;
}

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);
const files = (await readdir(folder)).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()));
const sourceUrls = await readSourceUrls(folder);

let added = 0;
let duplicates = 0;
let failed = 0;
for (const [i, file] of files.entries()) {
  try {
    const buffer = await normalize(await readFile(join(folder, file)));
    const { status } = await addReference(buffer, sourceName, sourceUrls.get(file) ?? null);
    if (status === "reference_saved") added++;
    else duplicates++;
  } catch (err) {
    failed++;
    console.warn(`Skipped ${file}: ${(err as Error).message}`);
  }
  if ((i + 1) % 25 === 0) console.log(`${i + 1}/${files.length}`);
}

const extra = [duplicates && `${duplicates} already stored`, failed && `${failed} failed`].filter(Boolean);
console.log(`Added ${added} ${sourceName} reference images${extra.length ? ` (${extra.join(", ")})` : ""}.`);
