import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { checkImage, hashImage, normalize } from "./matching.js";
import {
  embedImage,
  invalidateReferences,
  vectorToBlob,
  warmUp,
} from "./embeddings.js";
import "dotenv/config";

console.log(
  "Google Vision key loaded:",
  Boolean(process.env.GOOGLE_VISION_API_KEY),
);

const app = Fastify({ logger: true });

await mkdir("data/uploads", { recursive: true });
await app.register(multipart, {
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.get("/health", async () => ({ status: "ok", app: "vinted-checker" }));

// The paste page. Read on each request so edits show up on refresh.
app.get("/", async (_request, reply) => {
  const html = await readFile("public/index.html", "utf8");
  return reply.type("text/html; charset=utf-8").send(html);
});

app.get("/listings", async () => {
  return db.prepare("SELECT * FROM listings ORDER BY id DESC").all();
});

/** Reads the uploaded image, or sends a 400 and returns null. */
async function readImage(request: any, reply: any) {
  const file = await request.file();
  if (!file) {
    reply.code(400).send({ error: "Please upload an image." });
    return null;
  }
  if (!file.mimetype.startsWith("image/")) {
    reply.code(400).send({ error: "Only image uploads are supported." });
    return null;
  }
  const raw = await file.toBuffer();
  try {
    return { file, buffer: await normalize(raw) };
  } catch {
    reply.code(400).send({ error: "That file could not be read as an image." });
    return null;
  }
}

// Check a pasted image: save it, match it, store the matches.
app.post("/check", async (request, reply) => {
  const img = await readImage(request, reply);
  if (!img) return;

  const path = `data/uploads/${randomUUID()}.jpg`;
  await writeFile(path, img.buffer);

  const result = await checkImage(img.buffer);

  const save = db.transaction(() => {
    const listing = db
      .prepare("INSERT INTO listings (image_path) VALUES (?)")
      .run(path);
    const listingId = Number(listing.lastInsertRowid);
    const insert = db.prepare(
      "INSERT INTO matches (listing_id, source_name, source_url, similarity) VALUES (?, ?, ?, ?)",
    );
    for (const m of result.matches)
      insert.run(listingId, m.sourceName, m.sourceUrl, m.similarity);
    return listingId;
  });

  return { id: save(), imagePath: path, ...result };
});

// Teach the app an image you know is from a shop (multipart: file + source_name [+ source_url]).
app.post("/references", async (request, reply) => {
  const img = await readImage(request, reply);
  if (!img) return;

  const field = (name: string) =>
    (img.file.fields[name] as { value?: string } | undefined)?.value;
  const sourceName = field("source_name");
  if (!sourceName)
    return reply.code(400).send({ error: "source_name is required." });

  const hash = await hashImage(img.buffer);
  const embedding = vectorToBlob(await embedImage(img.buffer));
  db.prepare(
    "INSERT INTO reference_images (source_name, source_url, phash, embedding) VALUES (?, ?, ?, ?)",
  ).run(sourceName, field("source_url") ?? null, hash, embedding);
  invalidateReferences();
  return reply.code(201).send({ status: "reference_saved", sourceName });
});

const port = Number(process.env.PORT ?? 3000);

await app.listen({ port, host: "127.0.0.1" });

// Load the CLIP model in the background so the first paste isn't slow.
warmUp()
  .then(() => app.log.info("CLIP model ready"))
  .catch((err) =>
    app.log.error(
      err,
      "CLIP model failed to load (needs internet on first run)",
    ),
  );
