import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { REFERENCE_IMAGES_DIR, UPLOADS_DIR, db } from "./db.js";
import { checkImages, normalize, webSearchEnabled, type CheckResult } from "./matching.js";
import { MODELS, activeModel, embeddedCount, isModelName } from "./embeddings.js";
import { addReference, deleteReference, listReferences, updateReference } from "./references.js";

/** Most photos a single check accepts (Vinted allows up to 20, most listings have 3-8). */
export const MAX_PHOTOS = 8;

type Options = {
  /** Port the server will listen on; used to decide which Origin headers are our own page. */
  port: number;
  logger?: boolean;
};

type ListingRow = { id: number; image_path: string | null; result_json?: string | null; [k: string]: unknown };
type Upload = { buffers: Buffer[]; fields: Record<string, string> };

const fileName = (path: string) => path.split("/").pop()!;
const uploadUrl = (path: string) => `/uploads/${fileName(path)}`;

/** Builds the Fastify app with all routes, without starting it. Tests use `app.inject()`. */
export async function buildApp({ port, logger = true }: Options) {
  const app = Fastify({ logger });

  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: MAX_PHOTOS } });
  // The pages: / (check), /history.html, /references.html, plus shared CSS and JS.
  await app.register(fastifyStatic, { root: resolve("public") });

  /**
   * The server only listens on 127.0.0.1, but any website open in your browser
   * can still send a form POST to it. Reject writes that come from another origin.
   * Allowed: this app's own page, browser extensions (a website can't send an
   * extension origin), and requests without an Origin header (curl, scripts).
   */
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const isExtension = (origin: string) => /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin);
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin) && !isExtension(origin)) {
      return reply.code(403).send({ error: "Requests from other websites are not allowed." });
    }
  });

  app.get("/health", async () => {
    const model = activeModel();
    const total = (db.prepare("SELECT COUNT(*) AS n FROM reference_images").get() as { n: number }).n;
    return {
      status: "ok",
      app: "vinted-checker",
      webSearch: webSearchEnabled(),
      model,
      references: total,
      /** References with an embedding, per model. Fewer than `references` means `npm run reembed` is needed. */
      embedded: Object.fromEntries(Object.keys(MODELS).map((m) => [m, isModelName(m) ? embeddedCount(m) : 0])),
    };
  });

  // Stored photos. Names are always <uuid>.jpg, which also rules out path tricks.
  const servePhoto =
    (dir: string) => async (request: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
      const { name } = request.params;
      if (!/^[0-9a-f-]{36}\.jpg$/.test(name)) return reply.code(404).send({ error: "Not found." });
      let photo: Buffer;
      try {
        photo = await readFile(`${dir}/${name}`);
      } catch {
        return reply.code(404).send({ error: "Not found." });
      }
      // Set the type only once the file is read, so a 404 can still be sent as JSON.
      return reply.type("image/jpeg").send(photo);
    };
  app.get("/uploads/:name", servePhoto(UPLOADS_DIR));
  app.get("/reference-images/:name", servePhoto(REFERENCE_IMAGES_DIR));

  // --- Listings (checked photos) ---

  const listListings = db.prepare(
    `SELECT l.id, l.url, l.title, l.price, l.image_path, l.created_at,
            json_extract(l.result_json, '$.verdict') AS verdict,
            (SELECT COUNT(*) FROM listing_images i WHERE i.listing_id = l.id) AS image_count
     FROM listings l ORDER BY l.id DESC LIMIT ? OFFSET ?`,
  );
  const countListings = db.prepare("SELECT COUNT(*) AS n FROM listings");
  const getListing = db.prepare("SELECT * FROM listings WHERE id = ?");
  const imagesFor = db.prepare("SELECT image_path FROM listing_images WHERE listing_id = ? ORDER BY position");
  const matchesFor = db.prepare(
    "SELECT source_name, source_url, similarity, method FROM matches WHERE listing_id = ? ORDER BY id",
  );
  const insertListing = db.prepare(
    "INSERT INTO listings (url, title, price, image_path, result_json) VALUES (?, ?, ?, ?, ?)",
  );
  const insertImage = db.prepare("INSERT INTO listing_images (listing_id, position, image_path) VALUES (?, ?, ?)");
  const insertMatch = db.prepare(
    "INSERT INTO matches (listing_id, source_name, source_url, similarity, method) VALUES (?, ?, ?, ?, ?)",
  );
  const deleteMatches = db.prepare("DELETE FROM matches WHERE listing_id = ?");
  const deleteListingRow = db.prepare("DELETE FROM listings WHERE id = ?");

  const photoPaths = (id: number) => (imagesFor.all(id) as { image_path: string }[]).map((r) => r.image_path);

  app.get<{ Querystring: { limit?: string; offset?: string } }>("/listings", async (request) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(request.query.offset) || 0, 0);
    const rows = listListings.all(limit, offset) as ListingRow[];
    return {
      total: (countListings.get() as { n: number }).n,
      limit,
      offset,
      items: rows.map((r) => ({
        ...r,
        imageUrl: r.image_path ? uploadUrl(r.image_path) : null,
        matches: matchesFor.all(r.id),
      })),
    };
  });

  // One listing with its photos and full saved check result (null if it was saved without checking).
  app.get<{ Params: { id: string } }>("/listings/:id", async (request, reply) => {
    const row = getListing.get(Number(request.params.id)) as ListingRow | undefined;
    if (!row) return reply.code(404).send({ error: "Listing not found." });
    const { result_json, ...listing } = row;
    const imageUrls = photoPaths(row.id).map(uploadUrl);
    return {
      ...listing,
      imageUrl: imageUrls[0] ?? null,
      imageUrls,
      matches: matchesFor.all(row.id),
      result: typeof result_json === "string" ? JSON.parse(result_json) : null,
    };
  });

  app.delete<{ Params: { id: string } }>("/listings/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!getListing.get(id)) return reply.code(404).send({ error: "Listing not found." });
    const paths = photoPaths(id);
    db.transaction(() => {
      deleteMatches.run(id);
      deleteListingRow.run(id); // listing_images go with it (ON DELETE CASCADE)
    })();
    await Promise.all(paths.map((p) => unlink(p).catch(() => {})));
    return { status: "deleted" };
  });

  /**
   * Reads a multipart upload: up to MAX_PHOTOS images (field `file`, repeatable)
   * plus any text fields, in any order. Sends a 400 and returns null when there
   * is no usable image.
   */
  async function readUpload(request: FastifyRequest, reply: FastifyReply): Promise<Upload | null> {
    const fields: Record<string, string> = {};
    const raws: Buffer[] = [];
    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          const raw = await part.toBuffer();
          if (!part.mimetype.startsWith("image/")) {
            reply.code(400).send({ error: "Only image uploads are supported." });
            return null;
          }
          raws.push(raw);
        } else if (typeof part.value === "string") {
          fields[part.fieldname] = part.value;
        }
      }
    } catch (err) {
      if ((err as { code?: string }).code === "FST_FILES_LIMIT") {
        reply.code(400).send({ error: `Please upload at most ${MAX_PHOTOS} photos at once.` });
        return null;
      }
      throw err;
    }
    if (!raws.length) {
      reply.code(400).send({ error: "Please upload an image." });
      return null;
    }
    try {
      return { buffers: await Promise.all(raws.map(normalize)), fields };
    } catch {
      reply.code(400).send({ error: "That file could not be read as an image." });
      return null;
    }
  }

  /** Saves the photos, optional url/title/price and check result. Returns the listing id. */
  async function saveListing(upload: Upload, result?: CheckResult) {
    const paths = upload.buffers.map(() => `${UPLOADS_DIR}/${randomUUID()}.jpg`);
    await Promise.all(paths.map((p, i) => writeFile(p, upload.buffers[i]!)));
    const { url, title, price } = upload.fields;
    const id = db.transaction(() => {
      const listingId = Number(
        insertListing.run(
          url || null,
          title || null,
          price ? Number(price) || null : null,
          paths[0],
          result ? JSON.stringify(result) : null,
        ).lastInsertRowid,
      );
      paths.forEach((p, i) => insertImage.run(listingId, i, p));
      for (const m of result?.matches ?? []) {
        insertMatch.run(listingId, m.sourceName, m.sourceUrl, m.similarity, m.method);
      }
      return listingId;
    })();
    const imageUrls = paths.map(uploadUrl);
    return { id, imageUrl: imageUrls[0]!, imageUrls };
  }

  // Save photos (optional fields: url, title, price) without checking them.
  app.post("/listings", async (request, reply) => {
    const upload = await readUpload(request, reply);
    if (!upload) return;
    return reply.code(201).send(await saveListing(upload));
  });

  // Check one or more photos of a listing (optional fields: url, title, price), then save it.
  app.post("/check", async (request, reply) => {
    const upload = await readUpload(request, reply);
    if (!upload) return;
    const result = await checkImages(upload.buffers, request.log);
    return { ...(await saveListing(upload, result)), ...result };
  });

  // Save a checked listing's photos as references, so future checks recognise the item.
  app.post<{ Params: { id: string }; Body: { source_name?: string; source_url?: string } }>(
    "/listings/:id/reference",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!getListing.get(id)) return reply.code(404).send({ error: "Listing not found." });
      const sourceName = request.body?.source_name?.trim();
      if (!sourceName) return reply.code(400).send({ error: "source_name is required." });
      let saved = 0;
      let already = 0;
      for (const path of photoPaths(id)) {
        const r = await addReference(await readFile(path), sourceName, request.body.source_url || null);
        if (r.status === "reference_saved") saved++;
        else already++;
      }
      return reply.code(saved ? 201 : 200).send({
        status: saved ? "reference_saved" : "already_saved",
        sourceName,
        saved,
        alreadySaved: already,
      });
    },
  );

  // --- References (photos known to come from a shop) ---

  app.get<{ Querystring: { shop?: string } }>("/references", async (request) => {
    return listReferences(request.query.shop || null);
  });

  // Teach the app a photo you know is from a shop (multipart: file + source_name [+ source_url]).
  app.post("/references", async (request, reply) => {
    const upload = await readUpload(request, reply);
    if (!upload) return;
    const sourceName = upload.fields.source_name?.trim();
    if (!sourceName) return reply.code(400).send({ error: "source_name is required." });
    let saved = 0;
    for (const buffer of upload.buffers) {
      const r = await addReference(buffer, sourceName, upload.fields.source_url || null);
      if (r.status === "reference_saved") saved++;
    }
    return reply
      .code(saved ? 201 : 200)
      .send({ status: saved ? "reference_saved" : "already_saved", sourceName, saved });
  });

  app.patch<{ Params: { id: string }; Body: { source_name?: string; source_url?: string | null } }>(
    "/references/:id",
    async (request, reply) => {
      const sourceName = request.body?.source_name?.trim();
      if (request.body?.source_name !== undefined && !sourceName) {
        return reply.code(400).send({ error: "source_name can't be empty." });
      }
      const sourceUrl = request.body?.source_url === undefined ? undefined : request.body.source_url?.trim() || null;
      const result = updateReference(Number(request.params.id), { sourceName, sourceUrl });
      if (result === "not_found") return reply.code(404).send({ error: "Reference not found." });
      if (result === "conflict") {
        return reply.code(409).send({ error: `This photo is already saved as a ${sourceName} reference.` });
      }
      return { status: "updated" };
    },
  );

  app.delete<{ Params: { id: string } }>("/references/:id", async (request, reply) => {
    const deleted = await deleteReference(Number(request.params.id));
    if (!deleted) return reply.code(404).send({ error: "Reference not found." });
    return { status: "deleted" };
  });

  return app;
}
