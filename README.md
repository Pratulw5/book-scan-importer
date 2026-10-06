# book-scan-importer

Import scanned book covers (front + back) into Variety Book House. Reads the barcode on the back with
**zxing-cpp**, extracts title / price / blurb from both sides with **EasyOCR** (English + Hindi, with
Devanagari → Latin transliteration), and matches against `data/products.json`. No LLM required.

## How it works

1. **Barcode** back cover → EAN/ISBN + in-store Code-39 code. ISBN wins and also flips the image
   pair (front/back). A Code-39 that resolves to a product id becomes authoritative for pairing.
2. **OCR** both covers (uncropped originals) → title, price, blurb.
3. **Catalogue match** — title + transliterated Hindi + price against `data/products.json`; barcode
   hits steer the match and group front/back into one book.
4. Unmatched scans land in `needs_review` in the web UI, where you confirm or dismiss a candidate,
   then **commit** (Postgres row + R2 thumbnails).

## Prerequisites

- **Node.js ≥ 18** (https://nodejs.org)
- **Python 3.10–3.12** (3.12 recommended for EasyOCR/torch wheels; 3.14+ may be missing wheels)
  - Windows: install from python.org — the `py` launcher is used automatically
  - macOS (Apple Silicon): ensure a normal Python, not just the CLT stub
- **Git**

## Fresh start

Clone and install Node dependencies first:

```sh
git clone <repo-url> book-scan-importer
cd book-scan-importer
npm install
```

Install the Python tools. **macOS / Linux:**

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

**Windows (PowerShell):**

```powershell
py -3 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

> First EasyOCR run downloads its detection/recognition models automatically (~100 MB).
> If `python3` isn't active on PATH, set `PYTHON_BIN` (e.g. `$env:PYTHON_BIN = "py"` on Windows
> PowerShell) — the app auto-detects `py -3` on Windows otherwise.

## Configuration

Copy `.env.example` to `.env` and fill in the values:

```sh
cp .env.example .env        # Windows: copy .env.example .env
```

| Variable                  | Required for | Purpose                                         |
| ------------------------- | ------------ | ----------------------------------------------- |
| `DATABASE_URL`            | matching / commit | Neon Postgres connection for the product catalogue |
| `R2_ACCOUNT_ID` + keys    | commit       | Cloudflare R2 bucket for uploaded thumbnails     |
| `R2_BUCKET` / `R2_PUBLIC_URL` | commit   | R2 bucket name and public base URL               |
| `WEB_PORT`                | optional     | Web UI port (default `4173`)                     |

Matches against `data/products.json` (checked into the repo) work without a database. The DB is only
needed for non-dry-run commit.

## Run the pipeline

Dry-run on a folder of scans (does not touch the database):

```sh
node src/run.mjs "/path/to/scans" --dry-run
```

Helpful flags: `--limit N` (first N images), `--force` (re-process everything), `--web` (auto-open
the UI when done).

## Web UI

```sh
node src/web.mjs
# then open http://localhost:4173
```

- Review `needs_review` books and confirm/dismiss candidate products.
- "Use original" toggles a card's thumbnail between the SAM crop and the uncropped original.
- Commit writes books to Postgres and uploads thumbnails to R2.

## Tests

```sh
npm test
```

> On memory-constrained machines use `NODE_OPTIONS="--max-old-space-size=3072" npm test`
> (EasyOCR/SAM are skipped in tests via `BSI_SKIP_SAM=1`).

## Optional: SAM cropping (recommended)

The `crop_book.py` cover-crop uses Meta's Segment-Anything for clean cropping; **without it the code
falls back to a simple `trim()` crop** (fine for plain scans) and `BSI_SKIP_SAM=1` forces that. To
enable SAM:

```sh
python -m pip install "git+https://github.com/facebookresearch/segment-anything.git"
# download the 358 MB model next to the repo root:
curl -L -o sam_vit_b_01ec64.pth https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth
# Windows PowerShell: Invoke-WebRequest -Uri <url> -OutFile sam_vit_b_01ec64.pth
```

`sam_vit_b_01ec64.pth` is git-ignored, so a fresh clone always needs it downloaded.

## Troubleshooting

- **`python3: command not found`** → install Python, or set `PYTHON_BIN=python`
  (Windows: the app already uses the `py` launcher).
- **easyocr fails to import on startup** → the web health badge shows ❌ and details in the browser
  console; re-run `python -m pip install -r requirements.txt`.
- **No barcode read** → check the back cover is a scan with the barcode in frame; zxing is run on the
  uncropped original.
- **Empty titles** → OCR confidence now reports 0–100; if titles are still empty, check the image is
  sharp and upright.
- **Windows PowerShell shows `Activate.ps1` is not digitally signed** → run
  `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` first.