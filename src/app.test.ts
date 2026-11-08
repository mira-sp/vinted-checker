import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

// Must be set before the app modules load: they read these when imported.
const dataDir = mkdtempSync(join(tmpdir(), "vinted-checker-test-"));
process.env.DATA_DIR = dataDir;
process.env.GOOGLE_VISION_API_KEY = ""; // never call Google from tests

const PORT = 3000;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const { buildApp } = await import("./app.js");
const { db } = await import("./db.js");
type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let png: Buffer;

before(async () => {
  app = await buildApp({ port: PORT, logger: false });
  png = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#c33" } })
    .png()
    .toBuffer();
});

after(async () => {
  await app.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Builds a multipart body. Parts are sent in the order given. */
function multipart(parts: ({ name: string; value: string } | { name: string; file: Buffer; type: string })[]) {
  const boundary = "----test" + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    if ("file" in p) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="x"\r\n` +
            `Content-Type: ${p.type}\r\n\r\n`,
        ),
        p.file,
        Buffer.from("\r\n"),
      );
    } else {
      chunks.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

test("GET /health reports status and settings", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    status: "ok",
    app: "vinted-checker",
    webSearch: false,
    model: "clip",
    references: 0,
    embedded: { clip: 0, "fashion-siglip": 0 },
  });
});

test("POST /listings reads text fields sent after the file", async () => {
  const body = multipart([
    { name: "file", file: png, type: "image/png" },
    { name: "title", value: "Red top" },
    { name: "price", value: "4.5" },
  ]);
  const res = await app.inject({ method: "POST", url: "/listings", ...body });
  assert.equal(res.statusCode, 201);
  const { id, imageUrl } = res.json();

  const list = (await app.inject({ method: "GET", url: "/listings" })).json();
  const item = list.items.find((i: { id: number }) => i.id === id);
  assert.equal(item.title, "Red top");
  assert.equal(item.price, 4.5);

  const img = await app.inject({ method: "GET", url: imageUrl });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers["content-type"], "image/jpeg");
});

test("POST /check with no references and web search off finds nothing", async () => {
  const body = multipart([{ name: "file", file: png, type: "image/png" }]);
  const res = await app.inject({ method: "POST", url: "/check", ...body });
  assert.equal(res.statusCode, 200);
  const json = res.json();
  assert.equal(json.verdict, "no_match_found");
  assert.equal(json.clip, "no_references");
  assert.equal(json.webSearch, "disabled");
  assert.deepEqual(json.matches, []);
});

test("uploads are validated", async () => {
  const none = await app.inject({ method: "POST", url: "/check", ...multipart([{ name: "x", value: "y" }]) });
  assert.equal(none.statusCode, 400);

  const text = multipart([{ name: "file", file: Buffer.from("hello"), type: "text/plain" }]);
  assert.equal((await app.inject({ method: "POST", url: "/check", ...text })).statusCode, 400);

  const broken = multipart([{ name: "file", file: Buffer.from("not really a png"), type: "image/png" }]);
  const res = await app.inject({ method: "POST", url: "/check", ...broken });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /could not be read/);
});

test("POST /references requires source_name", async () => {
  const body = multipart([{ name: "file", file: png, type: "image/png" }]);
  const res = await app.inject({ method: "POST", url: "/references", ...body });
  assert.equal(res.statusCode, 400);
});

test("POST /listings/:id/reference returns 404 for an unknown listing", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/listings/999999/reference",
    payload: { source_name: "Shein" },
  });
  assert.equal(res.statusCode, 404);
});

test("POST requests from other websites are rejected", async () => {
  const body = multipart([{ name: "file", file: png, type: "image/png" }]);
  const evil = await app.inject({
    method: "POST",
    url: "/check",
    payload: body.payload,
    headers: { ...body.headers, origin: "https://evil.example" },
  });
  assert.equal(evil.statusCode, 403);

  const own = await app.inject({
    method: "POST",
    url: "/check",
    payload: body.payload,
    headers: { ...body.headers, origin: ORIGIN },
  });
  assert.equal(own.statusCode, 200);
});

test("GET /uploads rejects names that aren't upload ids", async () => {
  for (const url of ["/uploads/checker.db", "/uploads/..%2Fchecker.db", "/uploads/x.jpg"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 404, url);
  }
});

test("references added by another process are picked up without a restart", async () => {
  // Uses the fashion-siglip model, so checks (which use clip in tests) still
  // find no references and never download a model.
  const embedded = async () => (await app.inject({ method: "GET", url: "/health" })).json().embedded["fashion-siglip"];
  const before = await embedded();

  // A second connection, like `npm run ingest` running next to the server.
  const { default: Database } = await import("better-sqlite3");
  const other = new Database(join(dataDir, "checker.db"));
  const id = other
    .prepare("INSERT INTO reference_images (source_name, phash) VALUES (?, ?)")
    .run("Shein", "01".repeat(32)).lastInsertRowid;
  other
    .prepare("INSERT INTO embeddings (reference_id, model, vector) VALUES (?, ?, ?)")
    .run(id, "fashion-siglip", Buffer.alloc(768 * 4));
  other.close();

  assert.equal(await embedded(), before + 1);
});

test("POST requests from browser extensions are allowed", async () => {
  for (const origin of [
    "moz-extension://3f1c2a9e-7b4d-4c1e-9a2f-0d5e8b6c7a10",
    "chrome-extension://abcdefghijklmnop",
  ]) {
    const body = multipart([{ name: "file", file: png, type: "image/png" }]);
    const res = await app.inject({
      method: "POST",
      url: "/check",
      payload: body.payload,
      headers: { ...body.headers, origin },
    });
    assert.equal(res.statusCode, 200, origin);
  }
  const body = multipart([{ name: "file", file: png, type: "image/png" }]);
  const fake = await app.inject({
    method: "POST",
    url: "/check",
    payload: body.payload,
    headers: { ...body.headers, origin: "https://moz-extension.evil.example" },
  });
  assert.equal(fake.statusCode, 403);
});

test("GET /listings/:id returns the saved check result", async () => {
  const body = multipart([
    { name: "file", file: png, type: "image/png" },
    { name: "url", value: "https://www.vinted.de/items/123-top" },
    { name: "title", value: "Top" },
  ]);
  const checked = (await app.inject({ method: "POST", url: "/check", ...body })).json();

  const res = await app.inject({ method: "GET", url: `/listings/${checked.id}` });
  assert.equal(res.statusCode, 200);
  const listing = res.json();
  assert.equal(listing.url, "https://www.vinted.de/items/123-top");
  assert.equal(listing.imageUrl, checked.imageUrl);
  assert.equal(listing.result.verdict, checked.verdict);
  assert.deepEqual(listing.result.matches, checked.matches);

  assert.equal((await app.inject({ method: "GET", url: "/listings/999999" })).statusCode, 404);

  // The list view stays small: no full results in it.
  const list = (await app.inject({ method: "GET", url: "/listings" })).json();
  assert.ok(list.items.every((i: Record<string, unknown>) => !("result_json" in i)));
});

test("POST /check accepts several photos and DELETE /listings/:id removes them", async () => {
  const blue = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#33c" } })
    .png()
    .toBuffer();
  const body = multipart([
    { name: "file", file: png, type: "image/png" },
    { name: "file", file: blue, type: "image/png" },
  ]);
  const checked = (await app.inject({ method: "POST", url: "/check", ...body })).json();
  assert.equal(checked.imageUrls.length, 2);
  assert.equal(checked.images.length, 2);
  assert.deepEqual(
    checked.images.map((i: { index: number }) => i.index),
    [0, 1],
  );

  const listing = (await app.inject({ method: "GET", url: `/listings/${checked.id}` })).json();
  assert.deepEqual(listing.imageUrls, checked.imageUrls);

  const del = await app.inject({ method: "DELETE", url: `/listings/${checked.id}` });
  assert.equal(del.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/listings/${checked.id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: checked.imageUrls[1] })).statusCode, 404);
});

test("POST /check rejects more than the maximum number of photos", async () => {
  const parts = Array.from({ length: 9 }, () => ({ name: "file", file: png, type: "image/png" }));
  const res = await app.inject({ method: "POST", url: "/check", ...multipart(parts) });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /at most 8/);
});

test("Google Vision results are cached per photo", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({
        responses: [{ webDetection: { fullMatchingImages: [{ url: "https://img.ltwebstatic.com/a.jpg" }] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  process.env.GOOGLE_VISION_API_KEY = "test-key";
  try {
    const green = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#3c3" } })
      .png()
      .toBuffer();
    const check = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/check",
          ...multipart([{ name: "file", file: green, type: "image/png" }]),
        })
      ).json();

    const first = await check();
    assert.equal(first.webSearch, "used");
    assert.equal(first.verdict, "likely_fast_fashion");
    assert.equal(first.matches[0].sourceName, "Shein");

    const second = await check();
    assert.equal(second.webSearch, "cached");
    assert.equal(second.verdict, "likely_fast_fashion");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
    process.env.GOOGLE_VISION_API_KEY = "";
  }
});

test("references can be listed, re-labelled and deleted", async () => {
  // Insert directly (with a fake embedding) so the test doesn't download a model.
  const { REFERENCE_IMAGES_DIR } = await import("./db.js");
  const { writeFileSync, existsSync } = await import("node:fs");
  const path = `${REFERENCE_IMAGES_DIR}/00000000-0000-4000-8000-000000000001.jpg`;
  writeFileSync(path, await sharp(png).jpeg().toBuffer());
  const insert = db.prepare("INSERT INTO reference_images (source_name, phash, image_path) VALUES (?, ?, ?)");
  const a = Number(insert.run("Temu", "0110".repeat(16), path).lastInsertRowid);
  insert.run("Cider", "0110".repeat(16), null);

  const list = (await app.inject({ method: "GET", url: "/references?shop=Temu" })).json();
  const item = list.items.find((i: { id: number }) => i.id === a);
  assert.equal(item.sourceName, "Temu");
  assert.equal((await app.inject({ method: "GET", url: item.imageUrl })).statusCode, 200);
  assert.ok(list.shops.some((s: { name: string; count: number }) => s.name === "Temu" && s.count >= 1));

  const patch = (body: object) => app.inject({ method: "PATCH", url: `/references/${a}`, payload: body });
  assert.equal((await patch({ source_name: "Cider" })).statusCode, 409); // Cider already has this photo
  assert.equal((await patch({ source_name: "" })).statusCode, 400);
  assert.equal((await patch({ source_name: "Shein", source_url: "https://shein.com/x" })).statusCode, 200);
  const updated = (await app.inject({ method: "GET", url: "/references?shop=Shein" })).json();
  assert.equal(updated.items.find((i: { id: number }) => i.id === a).sourceUrl, "https://shein.com/x");

  assert.equal((await app.inject({ method: "DELETE", url: `/references/${a}` })).statusCode, 200);
  assert.equal(existsSync(path), false);
  assert.equal((await app.inject({ method: "DELETE", url: `/references/${a}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: `/references/${a}`, payload: {} })).statusCode, 404);
});
