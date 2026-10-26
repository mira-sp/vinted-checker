import Fastify from "fastify";
import multipart from "@fastify/multipart";
import sharp   from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { register } from "module";


const app = Fastify({ logger: true });

await mkdir("data/uploads", {recursive: true});
await app.register(multipart, {
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.get("/health", async () => ({
  status: "ok",
  app: "vinted-checker"
}));

app.get("/listings", async () => {
  return db.prepare(
    "SELECT * FROM listings ORDER BY id DESC"
  ).all();
});

app.get("/", async () => {
  return {
    app: "Vinted Checker",
    status: "running",
    endpoints: {
      health: "/health",
      listings: "/listings"
    }
  };
});


app.post("/listings", async (request, reply) => {
  const file = await request.file();

  if (!file) {
    return reply.code(400).send({
      error: "Please upload an image."
    });
  }

  if (!file.mimetype.startsWith("image/")) {
    return reply.code(400).send({
      error: "Only image uploads are supported."
    });
  }

  const id = randomUUID();
  const path = `data/uploads/${id}.jpg`;
  const buffer = await file.toBuffer();

  await sharp(buffer)
    .rotate()
    .resize({
      width: 1200,
      height: 1200,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({ quality: 85 })
    .toFile(path);

  const result = db.prepare(`
    INSERT INTO listings (image_path)
    VALUES (?)
  `).run(path);

  return reply.code(201).send({
    id: result.lastInsertRowid.toString(),
    imagePath: path,
    status: "image_saved",
    matching: "not_started"
  });
});

const port = Number(process.env.PORT ?? 3000);

await app.listen({
  port,
  host: "127.0.0.1"
});