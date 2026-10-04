# Book Scan Importer — Internal Contract

Standalone Node.js ESM program. Lives OUTSIDE the main repo. No repo code is modified.

## Layout

```
book-scan-importer/
├─ package.json          # type: module; scripts: test (vitest run), start, web
├─ .env.example
├─ .gitignore            # node_modules, .env, job/
├─ CONTRACT.md           # this file
├─ src/
│  ├─ run.mjs            # CLI: node src/run.mjs <folder> [--dry-run] [--limit N] [--web]
│  ├─ web.mjs            # UI server: node src/web.mjs [--port 4173]
│  ├─ config.mjs         # env loading + validation
│  ├─ state.mjs          # job/state.json load/save
│  ├─ image.mjs          # sharp crop/trim/orient/variants
│  ├─ llm.mjs            # LM Studio (OpenAI-compatible) vision calls
│  ├─ match.mjs          # normalise/levenshtein/scoring/price parsing (pure)
│  ├─ db.mjs             # pg Pool, parameterised queries only
│  ├─ r2.mjs             # S3 client for R2
│  ├─ pipeline.mjs       # orchestration: discover→crop→ocr→pair→match
│  ├─ commit.mjs         # upload variants + write to products (used by web UI)
│  └─ webui.html         # single-page review UI (inline CSS/JS)
├─ test/
│  └─ *.test.mjs         # vitest, no live DB/R2/LLM
└─ job/
   ├─ state.json
   └─ crops/<sha>.jpg
```

## Env vars (from `.env` at program root; `.env.example` documents all)

| Var | Default | Purpose |
| --- | --- | --- |
| `LMSTUDIO_HOST` | `http://127.0.0.1:1234` | LM Studio OpenAI-compatible server |
| `LMSTUDIO_MODEL` | *(empty → auto-pick first from `/v1/models`)* | vision model id |
| `DATABASE_URL` | *(required for matching/commit)* | Neon Postgres, same as main repo |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (`products`), `R2_PUBLIC_URL` | *(required for commit)* | Cloudflare R2 |
| `WEB_PORT` | `4173` | UI port |

Config validation: `loadConfig({ needDb, needR2, needLlm })` returns `{ ok, errors, config }` — never throws. `run.mjs` prints a friendly table of missing vars and exits 1.

## state.json (job/state.json) — single source of truth

```js
{
  folder: "/abs/path",          // the source folder this state belongs to
  dryRun: false,
  updatedAt: "ISO string",
  images: {
    [sha256Hex]: {
      sha, file, path,          // file = basename, path = absolute
      status: "pending" | "cropped" | "ocr_done" | "committed" | "failed",
      error: string | null,
      dims: { width, height },  // post-crop pixels
      ocr: null | {
        position: "front" | "back" | null,
        title, author, isbn,    // strings, "" if none
        priceText,              // exact printed price text, e.g. "₹499"
        price: number | null,   // parsed integer rupees
        blurb
      }
    }
  },
  books: {
    [key]: {                    // key = normalizedTitle or file basename (no extension)
      key, sortIndex,           // sortIndex = index of FRONT file in alphabetical folder order
      title, author, isbn, price: number | null, blurb,
      front: sha, back: sha | null,
      status: "matched" | "needs_review" | "unmatched" | "committed" | "created",
      dismissed: false,
      score: 0,
      matchReason: string,
      candidates: [ { id, title, author, mrp, isbn, score, titleScore, mrpMatch, authorMatch } ],
      chosenProductId: string | null,   // set by UI confirm
      createdProductId: string | null,  // set by UI create-product
      commitError: string | null,
      urls: null | { frontDetail, frontCard, backDetail, backCard }
    }
  }
}
```

State rules:
- `state.mjs` exports `JobState` class: `load()`, `save()` (atomic: write tmp + rename), `addImage`, `setBook`, `rebuildBooks(ocrBySha)` static helper is in pipeline instead.
- Folder guard: if a loaded state.json's `folder` differs from the CLI arg, error with exit (unless `--force` passed, which re-initialises).

## Image pipeline (`image.mjs`) — "orientation correct" requirement

Input: raw file buffer of a book scan on white paper.

1. `cropWhiteBg(buffer)` → `{ buffer (JPEG q90, no EXIF), width, height }`
   - `sharp(buffer).rotate()` (apply EXIF orientation), `.trim({ threshold: 12 })`
   - If trimmed width > height → `.rotate(90)` (portrait enforcement)
   - Output is always PORTRAIT (height >= width), EXIF stripped.
2. `buildVariants(buffer)` → `{ card: Buffer, detail: Buffer }`
   - card: `.resize({ width: 400, withoutEnlargement: true }).webp({ quality: 78 })`
   - detail: `.resize({ width: 1000, withoutEnlargement: true }).webp({ quality: 80 })`
   - (same specs as the main repo's `lib/r2-compress.mjs`)

Crop file written to `job/crops/<sha>.jpg` (displayed by UI, sent to LLM).

## LLM (`llm.mjs`) — LM Studio, OpenAI-compatible

- `listModels()` → GET `{host}/v1/models` → first `id`, or `LMSTUDIO_MODEL` if set.
- `visionExtract({ imageBuf, model })` → POST `{host}/v1/chat/completions`
  - `temperature: 0.1`, content: text prompt + `image_url` with `data:image/jpeg;base64,...`
  - System prompt (single JSON answer):
    ```
    You are reading a photo of a book cover (front or back) scanned on white paper.
    Respond with ONLY a JSON object, no markdown fences:
    {"position":"front"|"back"|"unknown","title":"","author":"","isbn":"","priceText":"","blurb":""}
    Rules:
    - "front" = cover shows the main title / cover art. Badges like "Bestseller" may appear on front.
    - "back" = shows a blurb/description paragraph, barcodes, or an ISBN number strip.
    - "title": main book title, "" if not visible. "author": author name, "" if not visible.
    - "isbn": digits only (10 or 13, no dashes), "" if not visible.
    - "priceText": any printed price EXACTLY as shown (e.g. "₹499"), "" if none.
    - "blurb": back-cover description, at most 2 sentences, "" if none.
    ```
  - Returns parsed JSON via `extractJson(text)` (balanced-brace scan — local models add prose). On parse failure or missing keys → one retry; then throw.
- ISBN-13 check-digit validation in `match.mjs` (`isValidIsbn`): invalid ISBNs are discarded (set "").

## Matching (`match.mjs`, pure functions, unit-tested)

- `normalize(s)`: lowercase, strip non-`[a-z0-9 ]`, collapse spaces.
- `levenshtein(a, b)`: standard DP.
- `titleScore(a, b)`: `max(0, 100 - 100 * dist / max(lenA, lenB, 1))` on normalized strings.
- `parsePrice(text)`: matches `/₹\s*(\d[\d,]*)/`, `/Rs\.?\s*(\d[\d,]*)/`, `/(INR)\s*(\d+)/i`; strips commas → int or null.
- `scoreCandidate(product, book)` where book = `{ title, author, isbn, price }`:
  - `titleScore` = titleScore(product.title, book.title)
  - `mrpMatch` = book.price != null && product.mrp === book.price
  - mrp score = book.price == null ? 8 : (mrpMatch ? 40 : 0)
  - `authorMatch` = both present && (norm(product.author).includes(norm(book.author)) || reverse)
  - author score = authorMatch ? 15 : 0
  - isbn bonus = 25 when both present and digit-strings equal
  - `score` = sum
- `rankBooks(products, book)` → sorted top-5 candidate objects (contract shape above).
- `decide(candidates, book)`:
  - no candidates → `{ status: "unmatched", reason }`
  - best.score >= 135 && (best.score - second.score) >= 15 → `matched`
  - else if best.score >= 95 → `needs_review`
  - else → `unmatched`
  - If DB unavailable → all books `needs_review` with reason "database unavailable — match manually".

## Pairing / books (pipeline)

- Group OCR'd images by `normalize(title)`; images with empty/failed title group under their file basename (one book per file).
- front = first image in group whose `position === "front"`; else alphabetically-first image in group.
- back = first image with `position === "back"` (different file from front); else null.
- `sortIndex` = index of front file in the alphabetical listing of the folder. Books are always processed/committed in ascending `sortIndex` ("first in folder = first in SQL").
- Book's `title/author/isbn/price/blurb`: prefer front image OCR, fall back to back image.
- ISBN: use front's valid ISBN, else back's valid ISBN.

## R2 (`r2.mjs`)

- `S3Client` (region `auto`, endpoint `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`) — same shape as repo `src/lib/r2.ts`.
- Keys (source folder sub-name sanitised, no dashes-underscores-only):
  - `optimized/card/<slug>/<safeFileName>.webp`
  - `optimized/detail/<slug>/<safeFileName>.webp`
  - slug = normalized title truncated to 60 chars (lowercase, spaces→`-`), else `book-<sha8>`
- `putIfMissing(key, body)` → HeadObject; on 404/NotFound Put with `ContentType: image/webp`, `CacheControl: public, max-age=31536000, immutable`.
- `publicUrl(key)` = `${R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`

## DB (`db.mjs`) — `pg` Pool, parameterised SQL only

- `fetchProducts()` → `SELECT id, title, author, mrp, "ISBN", images, thumbnails, orientation FROM products` (arrays as JS arrays via pg).
- `commitBook({ productId, newImages, newThumbnails, isbn, orientation: 'portrait' })`:
  - read current row, merge: `images = dedup([...newImages, ...existing])` — new URLs FIRST (front cover first), thumbnails aligned by same index pair order.
  - `UPDATE products SET images = $1, thumbnails = $2, "ISBN" = COALESCE("ISBN", $3) WHERE id = $4`
- `createProduct({ title, author, mrp, isbn, images, thumbnails })` →
  `INSERT INTO products (title, author, mrp, "ISBN", images, thumbnails, stock, "isActive", genre) VALUES (...) RETURNING id`
  (stock 0, isActive true, genre `[]`, `type` null)
- Pool: `new pg.Pool({ connectionString, max: 2, idleTimeoutMillis: 30000 })`; `close()` exported.

## Web UI (`web.mjs`, port WEB_PORT default 4173)

- `node:http` only, no framework. Serves `webui.html` at `/`.
- Routes:
  - `GET /` → html; `GET /health` → `{ ok: true }`
  - `GET /img/:sha` → `job/crops/<sha>.jpg` (image/jpeg; 404 if missing)
  - `GET /api/state` → `{ folder, dryRun, lms: { ok, model, host }, db: { ok }, r2: { ok }, counts: { matched, review, unmatched, failedImages, committed }, books: BookState[], images: ImageState[] }`
  - `POST /api/book/:key/confirm` body `{ productId }` → sets `chosenProductId`, status `matched`, saves
  - `POST /api/book/:key/dismiss` → `dismissed = true`
  - `POST /api/book/:key/create` body `{ title, author, mrp, isbn }` → `db.createProduct` (book's OCR values prefilled in UI) → sets `createdProductId`, status `created`
  - `POST /api/commit` → `commitConfirmed()` (commit.mjs): for each non-committed book with chosen or created product, in ascending sortIndex: upload variants → db.commitBook → status `committed`, store `urls`. Any error → book `commitError`, stays non-committed. Response: `{ results: [{ key, status, error }] }`
  - `POST /api/retry` → re-run crop+OCR for images with status `failed` (and any pending), then rebuild books + re-match, save. Response `{ retried, failed }`
- All state mutations go through `JobState.save()`.

## CLI (`run.mjs`)

```
node src/run.mjs <folder> [--dry-run] [--limit N] [--force] [--web]
```
- `--dry-run`: no R2 uploads, no DB writes (DB reads for matching allowed; if DB unreachable, books become `needs_review`).
- `--limit N`: process only first N unprocessed images.
- After pipeline: print table of books by status with top candidate, then hint `node src/web.mjs` to review. With `--web`, start the UI server inline.
- Never re-process `committed` or `ocr_done` images (idempotent); `failed` images only on explicit retry.

## Conventions

- ESM everywhere, Node >= 18, no TypeScript, no framework.
- No comments in code unless non-obvious WHY.
- No secrets in code: all from env (`.env` at program root, loaded via `dotenv/config` in config.mjs).
- Errors: log with `console.error`, mark state entry `failed`, never crash the whole batch.
