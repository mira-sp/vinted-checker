# Vinted Checker

A local app that checks whether a Vinted listing comes from a fast-fashion shop such as Shein or Temu. Add one or more photos of a listing and it tells you whether they look like products you have saved from those shops.

Everything runs on your own machine. Photos are stored locally and the app only listens on `127.0.0.1`. The only outgoing connections are the first-run model download and, if you turn it on, the optional web search (which sends the photos to Google).

## How it works

Each photo is compared in up to three ways:

| Signal                        | What it finds                                                       | Needs                     |
| ----------------------------- | ------------------------------------------------------------------- | ------------------------- |
| **Visual check** (main check) | The same product, even in a different photo                         | Reference photos you save |
| **Perceptual hash**           | Near-identical copies (resized, recompressed)                       | Reference photos you save |
| **Web search** (optional)     | Pages online that contain the photo, filtered to fast-fashion shops | A Google Cloud Vision key |

The visual check turns each photo into an embedding with an image model and compares it with your references. It uses the whole photo and three crops (centre, top half, bottom half), so a garment that fills only part of a Vinted photo can still match a studio shot. It recognises **the same item**, not a shop's general style: a Shein item you haven't saved won't match, however Shein-like it looks.

A listing can be checked with up to 8 photos at once. Each photo is checked on its own and the results are combined, because often only one photo (a label, a flat lay) matches a shop image.

Matches are de-duplicated and ordered by strength of evidence: near-identical copy, exact web match, visual match, partial web match, page match. Only the local checks have a real similarity score; web results only say what kind of match Google found.

The verdict is:

- **Likely from a fast-fashion shop**: a near-identical saved photo, an exact image match online, a visual match above the threshold, or two different kinds of web evidence.
- **Possibly from a fast-fashion shop**: only one kind of weak web evidence, such as a shop page that contains a similar image.
- **No match found**: none of the above. This does not prove the photo is original.

## Requirements

- Node.js 22 or newer
- Internet access the first time each image model is used (about 90 MB each). Models are cached afterwards.

## Setup

```bash
npm install
cp .env.example .env     # then edit .env (optional)
npm run dev
```

On Windows PowerShell use `Copy-Item .env.example .env` instead of `cp`.

Then open <http://127.0.0.1:3000>. Paste a photo with Ctrl+V (Cmd+V on Mac), or drop or choose up to 8 photos of one listing.

The app has three pages:

- **Check**: add photos and see the result.
- **History**: earlier checks with thumbnails and verdicts. Click one to see its full result again, or delete it.
- **References**: every saved reference photo, with the number per shop. Change a photo's shop or product link, delete it, or add new photos.

## Configuration

Settings are read from a `.env` file in the project folder (see `.env.example`). Environment variables set in the shell take precedence. Restart the app after changing them.

| Variable                | Default | Purpose                                                                     |
| ----------------------- | ------- | --------------------------------------------------------------------------- |
| `PORT`                  | `3000`  | Port to listen on                                                           |
| `GOOGLE_VISION_API_KEY` | not set | Turns on the web search. Without it only saved references are checked.      |
| `EMBEDDING_MODEL`       | `clip`  | Image model for the visual check: `clip` or `fashion-siglip` (see below)    |
| `CLIP_THRESHOLD`        | `0.88`  | Minimum visual similarity (0 to 1) for a match. Tune it with `npm run eval` |
| `DATA_DIR`              | `data`  | Folder for the database and photos                                          |

### Image models

| Name             | Model                                                                           | Notes                                     |
| ---------------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| `clip`           | [CLIP ViT-B/32](https://huggingface.co/Xenova/clip-vit-base-patch32)            | General-purpose. About 90 MB.             |
| `fashion-siglip` | [Marqo-FashionSigLIP](https://huggingface.co/Marqo/marqo-fashionSigLIP) (8-bit) | Trained on fashion products. About 94 MB. |

Scores from different models can't be compared, so each model needs its own embedding of every reference, and its own threshold. To switch:

1. `npm run reembed -- --model fashion-siglip` adds embeddings for that model. Existing ones are kept, so you can switch back.
2. `npm run eval -- --model clip,fashion-siglip` compares both models on your test photos and suggests a threshold for each.
3. Set `EMBEDDING_MODEL` and `CLIP_THRESHOLD` in `.env` and restart.

### Tuning the threshold

`npm run eval` measures how well the visual check separates shop photos from genuine ones. Put test photos in an `eval/` folder:

```
eval/
├─ shop/Shein/…       other photos of items you saved as Shein references (e.g. from Vinted listings)
├─ shop/Temu/…        the same for Temu (a folder per shop is optional)
└─ original/…         photos of items that are not from those shops
```

The test photos must be **different photos** from the references themselves; photos that are references are skipped. About 20 of each kind is enough for a first result. The report shows the score distribution, how many shop photos are found and how many genuine photos raise a false alarm at each threshold, the best balance, and the lowest threshold without false alarms. Every score is also written to `eval/results-<model>.csv`.

`eval/` is in `.gitignore`, so your test photos stay local.

## Adding reference photos

The app can only recognise what it has been shown. The most useful references are items that often get resold (bestsellers, viral pieces), with several photos each.

- **After a check:** pick the shop under "Know where this is from?" and click **Save as reference**. All photos of that check are saved.
- **On the References page:** choose a shop and add photos.
- **In bulk:** put photos in one folder per shop and run:

  ```bash
  npm run ingest -- ./refs/shein Shein
  npm run ingest -- ./refs/temu Temu
  ```

  To record where each photo came from, add a `sources.csv` to the folder with one `filename,url` line per photo. Photos already stored for that shop are skipped, so running ingest again is safe.

The `refs/` folder is in `.gitignore`: shop images are copyrighted, so keep them local.

## Browser extension (LibreWolf / Firefox)

The `extension/` folder is a browser extension that checks Vinted photos without saving and pasting them.

- **Right-click a photo** on Vinted and choose **Check with Vinted Checker**.
- **Or click the toolbar button** to check the largest Vinted photo on the page. Use this when Vinted's photo gallery hides the right-click menu.

The extension downloads the photo the same way your browser already did, sends it to the app with the listing's URL and title, and opens the result in a new tab. The toolbar icon shows `!` (likely), `?` (possible), `ok` (no match) or `x` (an error; hover for the message). The app must be running (`npm run dev`).

It only acts when you click, one photo at a time. It doesn't crawl Vinted.

**Install for testing** (removed when the browser restarts):

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and choose `extension/manifest.json`.

**Install permanently:**

1. Run `npm run extension:build`. This creates `dist-extension/vinted-checker.xpi`.
2. In `about:config`, set `xpinstall.signatures.required` to `false`. LibreWolf allows unsigned add-ons; regular Firefox only allows them in Developer Edition and Nightly.
3. In `about:addons`, open the gear menu, choose **Install Add-on From File…**, and pick `vinted-checker.xpi`.

After installing, open the add-on in `about:addons` and check under **Permissions** that access to `vinted.net` and `127.0.0.1` is turned on. Firefox may leave these off until you allow them. If you changed `PORT`, set the app's address in the add-on's **Options** too.

## API

| Method   | Path                      | Description                                                                                                |
| -------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET`    | `/health`                 | Health check: web search on or off, active model, references and embeddings per model                      |
| `POST`   | `/check`                  | Check 1–8 photos of a listing and save them (multipart: `file` repeated, optional `url`, `title`, `price`) |
| `GET`    | `/listings`               | Checked listings with verdict and matches, newest first. Query: `limit` (max 200), `offset`                |
| `GET`    | `/listings/:id`           | One listing with its photos and full saved result. The page shows it at `/?listing=<id>`                   |
| `POST`   | `/listings`               | Save photos without checking them (same fields as `/check`)                                                |
| `DELETE` | `/listings/:id`           | Delete a listing and its photos (references saved from it are kept)                                        |
| `POST`   | `/listings/:id/reference` | Save all photos of a listing as references (JSON: `source_name`, optional `source_url`)                    |
| `GET`    | `/references`             | All references with photo URL, and counts per shop. Query: `shop`                                          |
| `POST`   | `/references`             | Save 1–8 known shop photos (multipart: `file` repeated, `source_name`, optional `source_url`)              |
| `PATCH`  | `/references/:id`         | Change a reference's shop or link (JSON: `source_name`, `source_url`)                                      |
| `DELETE` | `/references/:id`         | Delete a reference and its photo                                                                           |
| `GET`    | `/uploads/:name`          | A checked photo, as linked by `imageUrls`                                                                  |
| `GET`    | `/reference-images/:name` | A reference photo                                                                                          |

Multipart fields can be sent in any order. Write requests sent by other websites (any `Origin` other than this app) are rejected, so a page open in your browser can't change your references or use up your Vision quota. Requests from browser extensions and requests without an `Origin` header, such as from `curl`, are allowed. A website can't pretend to be an extension.

Example response from `/check` with two photos:

```json
{
  "id": 12,
  "imageUrl": "/uploads/0b6c….jpg",
  "imageUrls": ["/uploads/0b6c….jpg", "/uploads/91fa….jpg"],
  "verdict": "likely_fast_fashion",
  "matches": [
    { "sourceName": "Shein", "sourceUrl": "https://...", "similarity": 0.93, "method": "clip", "image": 1 },
    {
      "sourceName": "Shein",
      "sourceUrl": "https://img.ltwebstatic.com/...",
      "similarity": null,
      "method": "web-partial",
      "image": 0
    }
  ],
  "webSearch": "used",
  "clip": "used",
  "model": "fashion-siglip",
  "web": { "pages": 4, "images": 11, "entities": [{ "description": "Dress", "score": 0.71 }] },
  "onlineFindings": [
    { "title": "Floral Wrap Dress | SHEIN", "url": "https://...", "type": "page", "sourceName": "Shein", "image": 0 }
  ],
  "closest": { "sourceName": "Shein", "score": 0.93, "image": 1 },
  "images": [
    {
      "index": 0,
      "verdict": "possible_fast_fashion",
      "matchCount": 1,
      "closest": { "sourceName": "Shein", "score": 0.71, "image": 0 }
    },
    {
      "index": 1,
      "verdict": "likely_fast_fashion",
      "matchCount": 1,
      "closest": { "sourceName": "Shein", "score": 0.93, "image": 1 }
    }
  ]
}
```

- `verdict`: `likely_fast_fashion`, `possible_fast_fashion` or `no_match_found`, combined over all photos. `images` has each photo's own verdict.
- `method`: `phash`, `web-full`, `clip` (visual check, whichever model), `web-partial` or `web-page`. `image` is the photo it came from (0-based).
- `webSearch`: `used`, `cached` (Google's result for the same photo was reused, see below), `disabled` (no key) or `failed`.
- `clip`: `used`, `no_references` or `failed` (model could not load; the rest of the check still runs).
- `onlineFindings`: everything Google returned, including results from sites that aren't known shops.

Google results are cached for 30 days per photo (by perceptual hash), so checking the same photo again doesn't cost another request.

## Scripts

| Script                                                 | What it does                                         |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `npm run dev`                                          | Start the server, restarting on code changes         |
| `npm run build`                                        | Compile TypeScript to `dist/`                        |
| `npm start`                                            | Run the compiled app                                 |
| `npm run ingest -- <folder> <SourceName>`              | Load a folder of reference photos                    |
| `npm run reembed [-- --model <name>]`                  | Add embeddings for a model to every reference        |
| `npm run eval [-- <folder>] [--model <name>[,<name>]]` | Measure accuracy and suggest a threshold (see above) |
| `npm test`                                             | Run the unit and API tests                           |
| `npm run typecheck`                                    | Check types without building                         |
| `npm run format`                                       | Format all files with Prettier                       |
| `npm run format:check`                                 | Check formatting (for CI or before committing)       |
| `npm run extension:lint`                               | Check the extension with Mozilla's linter            |
| `npm run extension:build`                              | Package the extension into `dist-extension/`         |

## Project structure

```
vinted-pipeline/
├─ package.json
├─ tsconfig.json
├─ .env.example           settings template, copy to .env
├─ public/
│  ├─ index.html          Check page
│  ├─ history.html        History page
│  ├─ references.html     References page
│  ├─ style.css           shared styles
│  └─ common.js           shared page helpers
├─ extension/             LibreWolf/Firefox extension (right-click a Vinted photo to check it)
├─ src/
│  ├─ server.ts           starts the server
│  ├─ app.ts              Fastify app and routes
│  ├─ app.test.ts         API tests (temporary data folder, no model download)
│  ├─ db.ts               SQLite setup and schema migrations
│  ├─ matching.ts         runs the checks and combines them into one result
│  ├─ sources.ts          shop domains, match merging and verdict rules (no I/O)
│  ├─ sources.test.ts     unit tests for sources.ts
│  ├─ embeddings.ts       image models, stored embeddings and similarity search
│  ├─ images.ts           photo normalising, hashing and crops
│  ├─ references.ts       saving, editing and re-embedding references
│  ├─ ingest.ts           command to bulk-load reference photos
│  ├─ reembed.ts          command to embed references with another model
│  ├─ eval.ts             command to measure accuracy and tune the threshold
│  └─ sharp-phash.d.ts    type declarations for sharp-phash
├─ refs/                  your reference photos for ingest (not committed)
├─ eval/                  your test photos for eval (not committed)
└─ data/                  created on first run (database and photos)
```

To recognise another shop online, add it to `SOURCES` in `src/sources.ts`. To offer it in the shop lists, add it to `SHOPS` in `public/common.js`; shops you have already used appear there automatically on the References page.

## Limitations

- **No reference photos, no visual match.** The visual and hash checks only compare against photos you have saved, and only recognise those exact items.
- **A match is a lead, not proof.** Plain basics such as a black ribbed top look alike across many shops, so open the linked source before drawing conclusions.
- **No match does not mean the photo is original.** The web search only finds images that search engines have indexed.
- **Scraping shop websites is not included.** Most of these sites block automated access and forbid it in their terms.

## Data

Everything is stored in `data/`: the SQLite database (`data/checker.db`), checked photos (`data/uploads/`) and reference photos (`data/reference/`). Delete the folder to start fresh. The database schema is versioned and upgrades itself on start. References saved before reference photos were kept get their photo back the first time you run `npm run reembed`, as long as the photo is still in `data/uploads/` or `refs/`.
