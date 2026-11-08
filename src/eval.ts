// Usage: npm run eval [-- <folder>] [--model <name>[,<name>...]]
//
// Measures how well the visual check separates shop photos from genuine ones,
// and suggests a CLIP_THRESHOLD. Folder layout (default folder: eval/):
//
//   eval/shop/<Shop>/*.jpg   photos of items that ARE among your references
//                            (a different photo, e.g. from a Vinted listing)
//   eval/shop/*.jpg          the same, shop not specified
//   eval/original/*.jpg      photos of items that are not from those shops
//
// Writes every score to eval/results-<model>.csv for your own analysis.
import "dotenv/config";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { db } from "./db.js";
import { activeModel, embeddedCount, isModelName, MODELS, nearest, type ModelName } from "./embeddings.js";
import { hashImage, normalize } from "./images.js";
import { clipThreshold, embedWithCrops } from "./matching.js";
import { hamming } from "./sources.js";

const args = process.argv.slice(2);
const modelArg = args.indexOf("--model");
const folder = args.find((a, i) => !a.startsWith("--") && (modelArg < 0 || i !== modelArg + 1)) ?? "eval";
const models = (modelArg >= 0 ? (args[modelArg + 1] ?? "") : activeModel()).split(",").filter(Boolean);
for (const m of models) {
  if (!isModelName(m)) {
    console.error(`Unknown model "${m}". Use one of: ${Object.keys(MODELS).join(", ")}.`);
    process.exit(1);
  }
}

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);

type Sample = { file: string; label: "shop" | "original"; expectedShop: string | null; buffer: Buffer };

async function loadSamples(): Promise<{ samples: Sample[]; skipped: string[] }> {
  const samples: Sample[] = [];
  const skipped: string[] = [];
  const refHashes = (db.prepare("SELECT phash FROM reference_images").all() as { phash: string }[]).map((r) => r.phash);

  for (const label of ["shop", "original"] as const) {
    const dir = join(folder, label);
    let files: string[];
    try {
      files = (await readdir(dir, { recursive: true })).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      const buffer = await normalize(await readFile(path));
      // A photo that is itself a reference would score ~1.0 and inflate the results.
      const hash = await hashImage(buffer);
      if (refHashes.some((h) => hamming(h, hash) <= 4)) {
        skipped.push(path);
        continue;
      }
      const sub = dirname(f);
      samples.push({
        file: relative(folder, path),
        label,
        expectedShop: label === "shop" && sub !== "." ? sub.split(sep)[0]! : null,
        buffer,
      });
    }
  }
  return { samples, skipped };
}

type Row = { file: string; label: "shop" | "original"; expectedShop: string | null; score: number; topShop: string };

function metrics(rows: Row[], t: number) {
  const shop = rows.filter((r) => r.label === "shop");
  const original = rows.filter((r) => r.label === "original");
  const tp = shop.filter((r) => r.score >= t).length;
  const fp = original.filter((r) => r.score >= t).length;
  const wrongShop = shop.filter((r) => r.score >= t && r.expectedShop && r.expectedShop !== r.topShop).length;
  const recall = shop.length ? tp / shop.length : 0;
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { t, tp, fp, wrongShop, recall, precision, f1, fpr: original.length ? fp / original.length : 0 };
}

const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN;
};

function histogram(rows: Row[]) {
  const shop = rows.filter((r) => r.label === "shop").map((r) => r.score);
  const original = rows.filter((r) => r.label === "original").map((r) => r.score);
  const lo = Math.floor(Math.min(...shop, ...original) * 20) / 20;
  console.log("\n  score       shop                original");
  for (let b = lo; b < 1; b += 0.05) {
    const inBucket = (x: number) => x >= b && x < b + 0.05;
    const s = shop.filter(inBucket).length;
    const o = original.filter(inBucket).length;
    console.log(`  ${b.toFixed(2)}-${(b + 0.05).toFixed(2)}  ${"#".repeat(s).padEnd(18)}  ${"#".repeat(o)}`);
  }
}

async function evaluate(model: ModelName, samples: Sample[]) {
  const count = embeddedCount(model);
  const total = (db.prepare("SELECT COUNT(*) AS n FROM reference_images").get() as { n: number }).n;
  if (!count) {
    console.log(`\n${model}: no references are embedded with this model. Run: npm run reembed -- --model ${model}`);
    return null;
  }
  if (count < total) {
    console.log(
      `\n${model}: only ${count} of ${total} references are embedded. Run: npm run reembed -- --model ${model}`,
    );
  }

  const rows: Row[] = [];
  for (const [i, s] of samples.entries()) {
    const [top] = nearest(await embedWithCrops(s.buffer, model), 1, model);
    rows.push({
      file: s.file,
      label: s.label,
      expectedShop: s.expectedShop,
      score: top!.score,
      topShop: top!.sourceName,
    });
    if (process.stdout.isTTY)
      process.stdout.write(`
${model}: ${i + 1}/${samples.length}`);
  }
  console.log();

  const csv = ["file,label,expected_shop,score,top_shop"]
    .concat(rows.map((r) => [r.file, r.label, r.expectedShop ?? "", r.score.toFixed(4), r.topShop].join(",")))
    .join("\n");
  const csvPath = join(folder, `results-${model}.csv`);
  await writeFile(csvPath, csv + "\n");

  const shop = rows.filter((r) => r.label === "shop").map((r) => r.score);
  const original = rows.filter((r) => r.label === "original").map((r) => r.score);
  console.log(`\n=== ${model} (${count} references) ===`);
  for (const [name, xs] of [
    ["shop", shop],
    ["original", original],
  ] as const) {
    console.log(
      `  ${name.padEnd(9)} n=${String(xs.length).padEnd(4)} min ${quantile(xs, 0).toFixed(3)}  ` +
        `median ${quantile(xs, 0.5).toFixed(3)}  max ${quantile(xs, 0.999).toFixed(3)}`,
    );
  }
  histogram(rows);

  const all = Array.from({ length: 50 }, (_, i) => metrics(rows, Math.round((0.5 + i * 0.01) * 100) / 100));
  const best = all.reduce((a, b) => (b.f1 >= a.f1 ? b : a));
  const zeroFp = all.find((m) => m.fp === 0);
  const current = metrics(rows, clipThreshold());

  console.log("\n  threshold  found shop  false alarms  wrong shop  precision");
  const show = new Map<number, string>();
  for (const t of [0.7, 0.75, 0.8, 0.85, 0.9, 0.95]) show.set(t, "");
  show.set(best.t, " <- best balance (F1)");
  if (zeroFp) show.set(zeroFp.t, (show.get(zeroFp.t) ?? "") + " <- lowest with no false alarms");
  show.set(current.t, (show.get(current.t) ?? "") + " <- your CLIP_THRESHOLD");
  for (const [t, note] of [...show].sort((a, b) => a[0] - b[0])) {
    const m = metrics(rows, t);
    console.log(
      `  ${t.toFixed(2)}       ${pct(m.recall)} (${m.tp})    ${pct(m.fpr)} (${m.fp})      ${String(m.wrongShop).padEnd(10)}  ${pct(m.precision)}${note}`,
    );
  }

  const misses = rows
    .filter((r) => r.label === "shop")
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);
  const alarms = rows
    .filter((r) => r.label === "original")
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  console.log("\n  Lowest-scoring shop photos (hardest to find):");
  for (const r of misses) console.log(`    ${r.score.toFixed(3)}  ${r.file}  (closest: ${r.topShop})`);
  console.log("  Highest-scoring originals (closest to a false alarm):");
  for (const r of alarms) console.log(`    ${r.score.toFixed(3)}  ${r.file}  (closest: ${r.topShop})`);
  console.log(`\n  All scores: ${csvPath}`);

  return { model, best, zeroFp };
}

const { samples, skipped } = await loadSamples();
if (skipped.length)
  console.log(
    `Skipped ${skipped.length} photos that are themselves references: ${skipped.map((s) => basename(s)).join(", ")}`,
  );
const nShop = samples.filter((s) => s.label === "shop").length;
const nOriginal = samples.length - nShop;
if (!nShop || !nOriginal) {
  console.error(
    `Need photos in both ${join(folder, "shop")} and ${join(folder, "original")} (found ${nShop} and ${nOriginal}).\n` +
      "shop/: other photos of items you saved as references (e.g. from Vinted listings), optionally in a folder per shop.\n" +
      "original/: photos of items that are not from those shops.",
  );
  process.exit(1);
}
console.log(`Evaluating ${nShop} shop and ${nOriginal} original photos.`);

const summaries = [];
for (const m of models as ModelName[]) {
  const s = await evaluate(m, samples);
  if (s) summaries.push(s);
}

if (summaries.length > 1) {
  console.log("\n=== Comparison ===");
  for (const s of summaries) {
    console.log(
      `  ${s.model.padEnd(15)} best F1 ${s.best.f1.toFixed(2)} at ${s.best.t.toFixed(2)}` +
        (s.zeroFp
          ? `; no false alarms from ${s.zeroFp.t.toFixed(2)}, finding ${pct(s.zeroFp.recall)} of shop photos`
          : ""),
    );
  }
}
