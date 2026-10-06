# Book Scan Importer — Internal Contract

Standalone Node.js ESM program. Lives OUTSIDE the main repo. No repo code is modified.

## Layout

```
book-scan-importer/
├─ package.json          # type: module; scripts: test (vitest run), start, web
├─ .env.example
├─ .gitignore            # node_modules, .env, job/
├─ CONTRACT.md           # this file
├─ requirements.txt      # python: zxing-cpp, easyocr (+ opencv, torch deps)
├─ read_barcodes.py      # batch barcode scan (zxing-cpp) — JSON file in/out
├─ ocr_batch.py          # batch EasyOCR (hi, en) — JSON file in/out
├─ crop_book.py          # SAM book segmentation → cropped image
├─ src/
│  ├─ run.mjs            # CLI: node src/run.mjs <folder> [--dry-run] [--limit N] [--web]
│  ├─ web.mjs            # UI server: node src/web.mjs [--port 4173]
│  ├─ config.mjs         # env loading + validation
│  ├─ state.mjs          # job/state.json load/save
│  ├─ image.mjs          # sharp crop/trim/orient/variants
│  ├─ py.mjs             # spawn helper for the python scripts (JSON file protocol)
│  ├─ barcode.mjs        # readBarcodes(images) → Map<id, barcodes[]> via read_barcodes.py
│  ├─ ocr.mjs            # runOcr(images) → Map<id, lines[]> via ocr_batch.py
│  ├─ shopcodes.mjs      # data/products_6digit.csv lookup (6-digit shop codes)
│  ├─ match.mjs          # normalise/levenshtein/scoring/barcode classify/title index (pure)
│  ├─ db.mjs             # pg Pool, parameterised queries only
│  ├─ r2.mjs             # S3 client for R2
│  ├─ pipeline.mjs       # orchestration: discover→crop→barcode+ocr→pair→match
│  ├─ commit.mjs         # upload variants + write to products (used by web UI)
│  └─ webui.html         # single-page review UI (inline CSS/JS)
├─ data/
│  ├─ products.json      # committed catalogue snapshot (matching source of truth)
│  └─ products_6digit.csv # product_name,product_code (6-digit shop sticker codes)
├─ test/
│  └─ *.test.mjs         # vitest, no live DB/R2/python
└─ job/
   ├─ state.json
   ├─ crops/<sha>.jpg    # display crop (white-bg trim)
   └─ originals/<sha>.jpg # normalized original used for barcode + OCR
```

## Env vars (from `.env` at program root; `.env.example` documents all)

| Var | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | *(required for commit only)* | Neon Postgres, same as main repo. Matching reads `data/products.json`. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (`products`), `R2_PUBLIC_URL` | *(required for commit)* | Cloudflare R2 |
| `WEB_PORT` | `4173` | UI port |

No LLM/OCR keys needed. Barcode + OCR run locally via `pip install -r requirements.txt` (zxing-cpp, EasyOCR, indic-transliteration); the web UI health check verifies the scripts and python imports.

Config validation: `loadConfig({ needDb, needR2 })` returns `{ ok, errors, config }` — never throws. `run.mjs` prints a friendly table of missing vars and exits 1.

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
      barcode: null | { isbn, shopCode, raw: [{ format, text, valid }] },
      productId: string | null,   // resolved catalogue id (shopcode or title match)
      matchMethod: null | "shopcode" | "title",
      useOriginal: false,         // UI toggle: upload job/originals/ instead of crops
      ocr: null | {
        position: "front" | "back",   // back = barcode present, else front
        title, author, isbn,    // strings, "" if none
        priceText,              // exact printed price text, e.g. "₹499"
        price: number | null,   // parsed integer rupees
        blurb
      }
    }
  },
  books: {
    [key]: {                    // key = "p:<productId>" if resolved, else "t:<normalizedTitle|fileBase>"
      key, sortIndex,           // sortIndex = index of FRONT file in alphabetical folder order
      title, author, isbn, price: number | null, blurb,
      front: sha, back: sha | null,
      productId: string | null, shopCode: string,   // "" when no 6-digit sticker
      matchMethod: null | "shopcode" | "title",
      barcodePresent: boolean,  // any raw barcode on any image in the group
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
   - Spawns `crop_book.py` (SAM + `sam_vit_b_01ec64.pth`) for book segmentation; on any failure falls back to `sharp .trim({ threshold: 150 })`. Set `BSI_SKIP_SAM=1` to skip the spawn entirely (tests do this — keeps vitest fast and low-memory).
   - `sharp(buffer).rotate()` (apply EXIF orientation) in all paths
   - If trimmed width > height → `.rotate(90)` (portrait enforcement)
   - Output is always PORTRAIT (height >= width), EXIF stripped.
2. `buildVariants(buffer)` → `{ card: Buffer, detail: Buffer }`
   - card: `.resize({ width: 400, withoutEnlargement: true }).webp({ quality: 78 })`
   - detail: `.resize({ width: 1000, withoutEnlargement: true }).webp({ quality: 80 })`
   - (same specs as the main repo's `lib/r2-compress.mjs`)

Two outputs written per image:
- `job/crops/<sha>.jpg` — white-bg trimmed display crop (UI thumbnails, upload default).
- `job/originals/<sha>.jpg` — orientation-normalized original (`toOriginalJpeg`, max side 2048, q85) used for **barcode + OCR**; UI can toggle per image (`useOriginal`) so a bad crop doesn't lose data. Commit uploads pick original vs crop accordingly (`commit.sourceFile`).

## Barcode + OCR (local python, no LLM)

- `src/py.mjs` `runPy(script, items, { timeout })`: writes `job/tmp/<name>-<rand>.json`, spawns `python3 <script> in out`, reads result, always unlinks temp files, captures stderr, throws with stderr snippet on failure or non-zero exit.
- `read_barcodes.py` — batch; per item tries original → 2× upscale → adaptive threshold, × 4 rotations via zxingcpp `read_barcodes`; stops at first hit; returns `[{ ok, barcodes: [{ format, text, valid }], error }]`.
- `ocr_batch.py` — batch; EasyOCR reader with `['hi','en']`, `gpu=False`, one Reader per run; lines sorted top→bottom: `[{ text, conf (0..100), box: [x, y, w, h], roman? }]`. `roman` is added when `text` is Devanagari: transliterated via `indic-transliteration` (IAST) then ASCII-folded and title-cased (`श्रीमद् भागवत पुराण` → `Srimad Bhagavata Purana`).
- `src/barcode.mjs` `readBarcodes(images)` → `Map<id, barcodes[]>`; `src/ocr.mjs` `runOcr(images)` → `Map<id, lines[]>`.
- Image flow in pipeline: crop + original written first (`status: 'cropped'`), then barcode batch, then OCR batch — both on the original path. A script failure throws and fails the job (no silent fallback).

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
- `parsePrice(text)` / `matchPrice(text)` → `null` or `{ value, text }`; `priceFromLines(lines)` takes the first conf ≥ 40 line with a price in 10..99999 → `{ price, priceText }`.
- `blurbFromLines(lines, title?)` → longest conf ≥ 40 line ≥ 80 chars (excluding the title line), as-is.
- `classifyBarcodes(raw)` → `{ isbn, shopCode }`:
  - format `EAN_13`/`ISBN`, 13 digits, `isValidIsbn` → isbn (raw `valid` flag ignored, checksum rules win)
  - exactly 6 digits → shopCode (shop sticker)
  - everything else ignored
- `matchNorm(s)` = `normalize(s)` + spelling folds for matching only (`sh`→`s`, `w`→`v`) — used by `titleScore`, the title index and exact lookups; NOT by `normalize` itself (slugs/grouping keys stay untouched).
- `titleScore(a, b)` scores on `matchNorm` of both sides.
- `bestTitleMatch(line, products, minScore=95)` → `{ product, score, exact, line }` or null. Uses a memoised title index (`titleIndex(products)`, WeakMap) on `matchNorm`: exact lookup first, else inverted token index narrows candidates, then `titleScore` ≥ minScore. Tries a trailing-schwa variant of the candidate (`bhagavata purana` → `bhagavat puran`) so transliterated Hindi matches human-typed catalogue spellings.
- `bestTitleMatchLines(lines, products, minScore)` scores the joined title block (`pickTitleFromLines`) plus each conf ≥ 40 line (original and `roman`), returns the best hit with the matched `line`.
- `pickTitleFromLines(lines)` (in match.mjs): groups conf ≥ 50 lines into vertically-adjacent blocks, picks the block with the tallest lines, joins top-to-bottom preferring `roman` over `text` (raw display title fallback).

## Shop codes (`shopcodes.mjs`)

- `data/products_6digit.csv` — columns `product_name,product_code` (6-digit sticker code), 78k+ rows, UTF-8 BOM stripped.
- `fetchShopCodes()` → memoised `Map<code, name>`; `parseCsv` handles quotes/CRLF/blank lines.
- `resolveShopCode(code, products)` → `{ name, product, score, exact }` via `bestTitleMatch(name, products, 95)`; null when unknown code or no ≥95 title match.

## Pairing / books (pipeline)

- Per image: `position = barcode present ? "back" : "front"` (barcode ⇒ back cover; no barcode ⇒ assume front).
- Title resolution per image (in order): shop code → `products_6digit.csv` name → catalogue product (`matchMethod: 'shopcode'`); else best OCR line ≥ 95 (`matchMethod: 'title'`); else heuristic largest text block (vertically-merged conf ≥ 50 lines, joined top-to-bottom) as raw title.
- Group key = `p:<productId>` when resolved, else `t:<normalizedTitle|fileBase>` — strict product-id pairing only (no filename-order pairing).
- Barcode-authoritative alignment: the catalogue contains duplicate titles (same title, different ids/MRPs). When any image in the run resolves its product via shop code, that id is recorded as authoritative for its title; after OCR, any `matchMethod: 'title'` image whose (catalogue) title equals it is re-pointed to the barcode-resolved id — so front/back group onto the id the barcode proved correct.
- front/back pick within the group as before: front = first `position === 'front'` (else first), back = different file with `position === 'back'`.
- `sortIndex` = index of front file in the alphabetical listing of the folder. Books are always processed/committed in ascending `sortIndex` ("first in folder = first in SQL").
- Book's `title/author/isbn/price/blurb`: prefer front image OCR, fall back to back image.
- ISBN: barcode ISBN first, else valid ISBN found in OCR lines (`isValidIsbn` check digit; invalid discarded).
- `matchBooks`: `matchMethod: 'shopcode'` → status `matched` directly (score = candidate's), unless the scanned price differs from catalogue MRP → `needs_review` with the conflict reason. `'title'`/no method → `decide()` on ranked candidates. When a barcode was found but nothing matched confidently → forced `needs_review` ("barcode found but no confident catalogue match") instead of `unmatched`. Missing product id in the snapshot → `needs_review` ("resolved product id missing from catalogue snapshot").

## R2 (`r2.mjs`)

- `S3Client` (region `auto`, endpoint `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`) — same shape as repo `src/lib/r2.ts`.
- Keys (source folder sub-name sanitised, no dashes-underscores-only):
  - `optimized/card/<slug>/<safeFileName>.webp`
  - `optimized/detail/<slug>/<safeFileName>.webp`
  - slug = normalized title truncated to 60 chars (lowercase, spaces→`-`), else `book-<sha8>`
- `putIfMissing(key, body)` → HeadObject; on 404/NotFound Put with `ContentType: image/webp`, `CacheControl: public, max-age=31536000, immutable`.
- `publicUrl(key)` = `${R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`

## Catalogue snapshot — matching never queries the database

- `data/products.json` is the committed source of truth for matching:
  `{ fetchedAt, count, products: [{ id, title, author, mrp, isbn }] }`.
- Regenerate with `node scripts/snapshot-products.mjs` (the only code that reads the `products` table wholesale).
- `fetchProducts()` reads and memoises that file — no pool, no network. Missing/corrupt file throws and all books fall back to `needs_review`.
- `DATABASE_URL` is needed only at commit time, not to match.

## DB (`db.mjs`) — `pg` Pool, parameterised SQL only. Commit path only.

- `fetchProducts()` → reads `data/products.json` (see above). **No SQL.**
- `commitBook({ productId, newImages, newThumbnails, isbn, orientation: 'portrait' })`:
  - read current row, merge: `images = dedup([...newImages, ...existing])` — new URLs FIRST (front cover first), thumbnails aligned by same index pair order.
  - `UPDATE products SET images = $1, thumbnails = $2, "ISBN" = COALESCE("ISBN", $3) WHERE id = $4`
- `createProduct({ title, author, mrp, isbn, images, thumbnails })` →
  `INSERT INTO products (title, author, mrp, "ISBN", images, thumbnails, stock, "isActive", genre) VALUES (...) RETURNING id`
  (stock 0, isActive true, genre `[]`, `type` null)
- Pool: `new pg.Pool({ connectionString, max: 2, idleTimeoutMillis: 30000 })`; opened lazily on the first write only; `close()` exported.

## Web UI (`web.mjs`, port WEB_PORT default 4173)

- `node:http` only, no framework. Serves `webui.html` at `/`.
- Routes:
  - `GET /` → html; `GET /health` → `{ ok: true }`
  - `GET /img/:sha?src=orig` → `job/crops/<sha>.jpg`, or `job/originals/<sha>.jpg` when `src=orig` (cross-fallback if missing)
  - `GET /api/state` → `{ folder, dryRun, ocr: { ok, error? }, db: { ok }, r2: { ok }, counts: { matched, review, unmatched, failedImages, committed }, books: BookState[], images: ImageState[] }`
    - `ocr.ok` = python scripts present and `python3 -c "import zxingcpp, cv2, easyocr"` succeeds (memoised per process)
  - `POST /api/image/:sha/source` body `{ source: "crop" | "original" }` → sets `useOriginal` on the image, saves; 404 for unknown sha
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
