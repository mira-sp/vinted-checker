# Vinted Checker

A local app that checks whether a photo, for example from a Vinted listing, comes from a fast-fashion shop such as Shein or Temu. Paste an image into the page and it tells you whether it looks like a known product from those shops.

Everything runs on your own machine. Images are stored locally and the app only listens on `127.0.0.1`. The only outgoing connections are the first-run model download and, if you turn it on, the optional web search (which sends the image to Google).

## How it works

A pasted image is compared in up to three ways:

| Signal                           | What it finds                                                       | Needs                      |
| -------------------------------- | ------------------------------------------------------------------- | -------------------------- |
| **CLIP embeddings** (main check) | Visually similar products, even from a different photo              | Reference images you saved |
| **Perceptual hash**              | Near-identical copies (resized, recompressed)                       | Reference images you saved |
| **Web search** (optional)        | Pages online that contain the image, filtered to fast-fashion shops | A Google Cloud Vision key  |

For the CLIP check, the image is compared as a whole and as three crops (centre, top half, bottom half), so a garment that fills only part of a Vinted photo can still match a studio shot.

Matches are de-duplicated and ordered by strength of evidence: near-identical copy, exact web match, CLIP match, partial web match, page match. Only the local checks have a real similarity score; web results only say what kind of match Google found.

The verdict is:

- **Likely from a fast-fashion shop**: a near-identical saved image, an exact image match online, a CLIP match above the threshold, or two different kinds of web evidence.
- **Possibly from a fast-fashion shop**: only one kind of weak web evidence, such as a shop page that contains a similar image.
- **No match found**: none of the above. This does not prove the photo is original.

## Requirements

- Node.js 22 or newer
- Internet access on the first run, to download the CLIP model (about 90 MB). It is cached afterwards.

## Setup

```bash
npm install
cp .env.example .env     # then edit .env (optional)
npm run dev
```

On Windows PowerShell use `Copy-Item .env.example .env` instead of `cp`.

Then open <http://127.0.0.1:3000> and paste an image with Ctrl+V (Cmd+V on Mac). You can also drop a file onto the page or click it to choose one.

## Configuration

Settings are read from a `.env` file in the project folder (see `.env.example`). Environment variables set in the shell take precedence.

| Variable                | Default | Purpose                                                                |
| ----------------------- | ------- | ---------------------------------------------------------------------- |
| `PORT`                  | `3000`  | Port to listen on                                                      |
| `GOOGLE_VISION_API_KEY` | not set | Turns on the web search. Without it only saved references are checked. |
| `CLIP_THRESHOLD`        | `0.88`  | Minimum similarity (0 to 1) for a visual match                         |
| `DATA_DIR`              | `data`  | Folder for the database and uploads                                    |

### Tuning the threshold

The right threshold depends on your reference images. The result page shows the closest saved reference and its score even when it is below the threshold. Paste a few images you know are from a shop and a few that are not, compare the scores, and choose a value between the two groups.

## Adding reference images

The app can only recognise what it has been shown. There are three ways to teach it.

**From the page.** After a check, pick the shop under "Know where this is from?" and click **Save as reference**. The checked image is stored as a reference, so the next check of the same item is recognised.

**In bulk.** Save product images from a shop in one folder per shop, then load them:

```bash
npm run ingest -- ./refs/shein Shein
npm run ingest -- ./refs/temu Temu
```

To record where each image came from, add a `sources.csv` to the folder with one `filename,url` line per image. Images already stored for that shop are skipped, so running ingest again is safe.

The `refs/` folder is in `.gitignore`: shop images are copyrighted, so keep them local.

**Through the API**, one image at a time:

```bash
curl -F "file=@dress.jpg" -F "source_name=Shein" -F "source_url=https://..." \
  http://127.0.0.1:3000/references
```

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

| Method | Path                      | Description                                                                                       |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET`  | `/`                       | The paste page                                                                                    |
| `GET`  | `/health`                 | Health check, whether web search is on, and the number of saved references                        |
| `GET`  | `/listings`               | Checked listings with their matches, newest first. Query: `limit` (max 200), `offset`             |
| `GET`  | `/listings/:id`           | One listing with its full saved check result. The page shows it at `/?listing=<id>`               |
| `POST` | `/listings`               | Save an image without checking it (multipart: `file`, optional `url`, `title`, `price`)           |
| `POST` | `/check`                  | Check an image and save it with its matches (multipart: `file`, optional `url`, `title`, `price`) |
| `POST` | `/references`             | Save a known shop image (multipart: `file`, `source_name`, optional `source_url`)                 |
| `POST` | `/listings/:id/reference` | Save a checked listing's image as a reference (JSON: `source_name`, optional `source_url`)        |
| `GET`  | `/uploads/:name`          | A saved upload, as linked by `imageUrl`                                                           |

Multipart fields can be sent in any order. `POST` requests sent by other websites (any `Origin` other than this app) are rejected, so a page open in your browser can't add references or use up your Vision quota. Requests from browser extensions and requests without an `Origin` header, such as from `curl`, are allowed. A website can't pretend to be an extension.

Example response from `/check`:

```json
{
  "id": 12,
  "imageUrl": "/uploads/0b6c….jpg",
  "verdict": "likely_fast_fashion",
  "matches": [
    { "sourceName": "Shein", "sourceUrl": "https://...", "similarity": 0.93, "method": "clip" },
    {
      "sourceName": "Shein",
      "sourceUrl": "https://img.ltwebstatic.com/...",
      "similarity": null,
      "method": "web-partial"
    }
  ],
  "webSearch": "used",
  "clip": "used",
  "web": { "pages": 4, "images": 11, "entities": [{ "description": "Dress", "score": 0.71 }] },
  "onlineFindings": [
    { "title": "Floral Wrap Dress | SHEIN", "url": "https://...", "type": "page", "sourceName": "Shein" }
  ],
  "closest": { "sourceName": "Shein", "score": 0.93 }
}
```

- `verdict`: `likely_fast_fashion`, `possible_fast_fashion` or `no_match_found`
- `method`: `phash`, `web-full`, `clip`, `web-partial` or `web-page`
- `webSearch`: `used`, `disabled` (no key) or `failed`
- `clip`: `used`, `no_references` or `failed` (model could not load; the rest of the check still runs)
- `onlineFindings`: everything Google returned, including results from sites that aren't known shops

## Scripts

| Script                                    | What it does                                   |
| ----------------------------------------- | ---------------------------------------------- |
| `npm run dev`                             | Start the server, restarting on changes        |
| `npm run build`                           | Compile TypeScript to `dist/`                  |
| `npm start`                               | Run the compiled app                           |
| `npm run ingest -- <folder> <SourceName>` | Load a folder of reference images              |
| `npm test`                                | Run the unit and API tests                     |
| `npm run typecheck`                       | Check types without building                   |
| `npm run format`                          | Format all files with Prettier                 |
| `npm run format:check`                    | Check formatting (for CI or before committing) |
| `npm run extension:lint`                  | Check the extension with Mozilla's linter      |
| `npm run extension:build`                 | Package the extension into `dist-extension/`   |

## Project structure

```
vinted-pipeline/
├─ package.json
├─ tsconfig.json
├─ .env.example           settings template, copy to .env
├─ public/
│  └─ index.html          the paste page
├─ extension/             LibreWolf/Firefox extension (right-click a Vinted photo to check it)
├─ src/
│  ├─ server.ts           starts the server
│  ├─ app.ts              Fastify app and routes
│  ├─ app.test.ts         API tests (temporary data folder, no model download)
│  ├─ db.ts               SQLite setup and schema migrations
│  ├─ matching.ts         runs the checks and combines them into one result
│  ├─ sources.ts          shop domains, match merging and verdict rules (no I/O)
│  ├─ sources.test.ts     unit tests for sources.ts
│  ├─ embeddings.ts       CLIP model, vector storage and similarity search
│  ├─ ingest.ts           command to bulk-load reference images
│  └─ sharp-phash.d.ts    type declarations for sharp-phash
├─ refs/                  your reference images (not committed)
└─ data/                  created on first run (database and uploads)
```

To recognise another shop, add it to `SOURCES` in `src/sources.ts` and to the `SHOPS` list in `public/index.html`.

## Limitations

- **No reference images, no visual match.** The CLIP and hash checks only compare against images you have saved.
- **A match is a lead, not proof.** Plain basics such as a black ribbed top look alike across many shops, so open the linked source before drawing conclusions.
- **No match does not mean the photo is original.** The web search only finds images that search engines have indexed.
- **Scraping shop websites is not included.** Most of these sites block automated access and forbid it in their terms.

## Data

Everything is stored in `data/`: the SQLite database (`data/checker.db`) and the uploaded images (`data/uploads/`). Delete the folder to start fresh. The database schema is versioned and upgrades itself on start.
