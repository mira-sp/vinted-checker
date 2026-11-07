// Must be the first import: ES modules run in import order, and other modules
// read environment variables when they load.
import "dotenv/config";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { db, saveReference } from "./db.js";
import { checkImage, hashImage, normalize, webSearchEnabled, type Match } from "./matching.js";
import { embedImage, invalidateReferences, referenceCount, vectorToBlob, warmUp } from "./embeddings.js";

const port = Number(process.env.PORT ?? 3000);
const app = Fastify({ logger: true });

await mkdir("data/uploads", { recursive: true });
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

/**
 * The server only listens on 127.0.0.1, but any website open in your browser
 * can still send a form POST to it. Reject writes that come from another origin.
 * Requests without an Origin header (curl, scripts) are allowed.
 */
const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
app.addHook("onRequest", async (request, reply) => {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    return reply.code(403).send({ error: "Requests from other websites are not allowed." });
  }
});

app.get("/health", async () => ({
  status: "ok",
  app: "vinted-checker",
  webSearch: webSearchEnabled(),
  references: referenceCount(),
}));

// The paste page. Read on each request so edits show up on refresh.
app.get("/", async (_request, reply) => {
  const html = await readFile("public/index.html", "utf8");
  return reply.type("text/html; charset=utf-8").send(html);
});

// Saved uploads. Names are always <uuid>.jpg, which also rules out path tricks.
app.get<{ Params: { name: string } }>("/uploads/:name", async (request, reply) => {
  const { name } = request.params;
  if (!/^[0-9a-f-]{36}\.jpg$/.test(name)) return reply.code(404).send({ error: "Not found." });
  try {
    return reply.type("image/jpeg").send(await readFile(`data/uploads/${name}`));
  } catch {
    return reply.code(404).send({ error: "Not found." });
  }
});

const listListings = db.prepare("SELECT * FROM listings ORDER BY id DESC LIMIT ? OFFSET ?");
const countListings = db.prepare("SELECT COUNT(*) AS n FROM listings");
const getListing = db.prepare("SELECT * FROM listings WHERE id = ?");
const matchesFor = db.prepare(
  "SELECT source_name, source_url, similarity, method FROM matches WHERE listing_id = ? ORDER BY id",
);
const insertListing = db.prepare("INSERT INTO listings (url, title, price, image_path) VALUES (?, ?, ?, ?)");
const insertMatch = db.prepare(
  "INSERT INTO matches (listing_id, source_name, source_url, similarity, method) VALUES (?, ?, ?, ?, ?)",
);

type ListingRow = { id: number; image_path: string | null; [k: string]: unknown };

app.get<{ Querystring: { limit?: string; offset?: string } }>("/listings", async (request) => {
  const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(request.query.offset) || 0, 0);
  const rows = listListings.all(limit, offset) as ListingRow[];
  return {
    total: (countListings.get() as { n: number }).n,
    limit,
    offset,
    items: rows.map((r) => ({ ...r, matches: matchesFor.all(r.id) })),
  };
});

type Upload = { buffer: Buffer; fields: Record<string, string> };

/**
 * Reads a multipart upload: one image (field `file`) plus any text fields, in
 * any order. Sends a 400 and returns null when there is no usable image.
 */
async function readUpload(request: FastifyRequest, reply: FastifyReply): Promise<Upload | null> {
  const fields: Record<string, string> = {};
  let raw: Buffer | null = null;
  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (!part.mimetype.startsWith("image/")) {
        await part.toBuffer(); // drain the stream before replying
        reply.code(400).send({ error: "Only image uploads are supported." });
        return null;
      }
      raw = await part.toBuffer();
    } else if (typeof part.value === "string") {
      fields[part.fieldname] = part.value;
    }
  }
  if (!raw) {
    reply.code(400).send({ error: "Please upload an image." });
    return null;
  }
  try {
    return { buffer: await normalize(raw), fields };
  } catch {
    reply.code(400).send({ error: "That file could not be read as an image." });
    return null;
  }
}

/** Saves the image and an optional url/title/price, plus any matches. Returns the listing id. */
async function saveListing(upload: Upload, matches: Match[] = []) {
  const name = `${randomUUID()}.jpg`;
  const path = `data/uploads/${name}`;
  await writeFile(path, upload.buffer);
  const { url, title, price } = upload.fields;
  const id = db.transaction(() => {
    const listingId = Number(
      insertListing.run(url || null, title || null, price ? Number(price) || null : null, path).lastInsertRowid,
    );
    for (const m of matches) insertMatch.run(listingId, m.sourceName, m.sourceUrl, m.similarity, m.method);
    return listingId;
  })();
  return { id, imageUrl: `/uploads/${name}` };
}

// Save an image (optional fields: url, title, price) without checking it.
app.post("/listings", async (request, reply) => {
  const upload = await readUpload(request, reply);
  if (!upload) return;
  return reply.code(201).send(await saveListing(upload));
});

// Check an image (optional fields: url, title, price): match it, then save it with its matches.
app.post("/check", async (request, reply) => {
  const upload = await readUpload(request, reply);
  if (!upload) return;
  const result = await checkImage(upload.buffer, request.log);
  return { ...(await saveListing(upload, result.matches)), ...result };
});

async function addReference(buffer: Buffer, sourceName: string, sourceUrl: string | null) {
  const hash = await hashImage(buffer);
  const embedding = vectorToBlob(await embedImage(buffer));
  const added = saveReference(sourceName, sourceUrl, hash, embedding);
  if (added) invalidateReferences();
  return { status: added ? "reference_saved" : "already_saved", sourceName };
}

// Teach the app an image you know is from a shop (multipart: file + source_name [+ source_url]).
app.post("/references", async (request, reply) => {
  const upload = await readUpload(request, reply);
  if (!upload) return;
  const sourceName = upload.fields.source_name?.trim();
  if (!sourceName) return reply.code(400).send({ error: "source_name is required." });
  const result = await addReference(upload.buffer, sourceName, upload.fields.source_url || null);
  return reply.code(result.status === "reference_saved" ? 201 : 200).send(result);
});

// Confirm a checked listing as coming from a shop, so future checks recognise it.
app.post<{ Params: { id: string }; Body: { source_name?: string; source_url?: string } }>(
  "/listings/:id/reference",
  async (request, reply) => {
    const listing = getListing.get(Number(request.params.id)) as ListingRow | undefined;
    if (!listing?.image_path) return reply.code(404).send({ error: "Listing not found." });
    const sourceName = request.body?.source_name?.trim();
    if (!sourceName) return reply.code(400).send({ error: "source_name is required." });
    const buffer = await readFile(listing.image_path);
    const result = await addReference(buffer, sourceName, request.body.source_url || null);
    return reply.code(result.status === "reference_saved" ? 201 : 200).send(result);
  },
);

app.log.info({ webSearch: webSearchEnabled() }, "Google Vision web search");

await app.listen({ port, host: "127.0.0.1" });

// Load the CLIP model in the background so the first paste isn't slow.
warmUp()
  .then(() => app.log.info("CLIP model ready"))
  .catch((err) => app.log.error({ err }, "CLIP model failed to load (needs internet on first run)"));
