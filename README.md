# ocr-mcp

MCP server for OCR and document scanning. Exposes tools for image text extraction, scanner control, searchable PDF generation, and Nextcloud filing. Used with OpenClaw (AI assistant gateway) via web UI and Telegram.

## Architecture

```
Physical scanner (Canon MF741C / HP Officejet 5740)
    ↓
scanimage (SANE / sane-airscan)
    ↓
polycr :8000  — multi-engine OCR (text extraction + classification)
    ↓
ocrmypdf :8001 — searchable PDF generation (rotate, deskew, optimize)
    ↓
Nextcloud (WebDAV)
```

Web UI attachments take a parallel path:

```
Browser file upload → ~/.openclaw/media/inbound/
    ↓
ocr__ocr_inbound_media → polycr :8000
```

## Tools

| Tool | Description |
|------|-------------|
| `ocr__quick_scan` | Zero-config scan: Canon MF741C ADF → OCR → PDF → Nextcloud. No parameters needed. |
| `ocr__scan_and_file` | Full pipeline with options: scanner, profile, description, path, filename overrides. |
| `ocr__ocr_inbound_media` | OCR a photo attached via the OpenClaw web GUI. Reads from `~/.openclaw/media/inbound/`. Pass `media_id` from the `[media attached: media://inbound/<id>]` marker, or omit to use the most recent upload. Optionally files to Nextcloud with `file_nextcloud: true`. |
| `ocr__nextcloud_move` | Move or rename a file already in Nextcloud (WebDAV MOVE). Use to correct a bad filename after filing. |
| `ocr__scan_document` | Low-level single-page scan to a local file path. |
| `ocr__create_searchable_pdf` | Convert an image to a searchable PDF via ocrmypdf service. Falls back to local CLI then Tesseract. |
| `ocr__ocr_image_polycr` | OCR an image via polycr with Tesseract fallback. |
| `ocr__ocr_image_local` | OCR using local Tesseract only — no network dependency. |
| `ocr__ocr_image_from_base64` | OCR a base64-encoded image. |
| `ocr__ocr_image_from_url` | Download and OCR an image from a URL. |
| `ocr__extract_event_details` | OCR and classify a document for structured event extraction. |
| `ocr__auto_orient_image` | Fix image rotation via EXIF metadata. |
| `ocr__rotate_image` | Rotate an image by explicit degrees. |
| `ocr__enhance_image_for_ocr` | Preprocess an image for better OCR (contrast, sharpen, binarize). |

## Scanning Profiles

| Profile | Source | Mode | Use For |
|---------|--------|------|---------|
| `doc-bw-adf` | ADF | B&W | Multi-page documents (default) |
| `doc-bw` | Flatbed | B&W | Single-page flatbed |
| `doc-color` | Flatbed | Color | Color documents |
| `receipt` | Flatbed | B&W | Receipts |
| `id-card` | Flatbed | Color | ID cards, insurance cards |
| `photo` | Flatbed | Color | Photos |

## Scanners

| ID | Device | Notes |
|----|--------|-------|
| `canon-mf741c` | `airscan:e0:Canon MF741C` | Primary. ADF + flatbed. IP: 192.168.1.141. Configured in `/etc/sane.d/airscan.conf`. |
| `hp-officejet-5740` | `escl:http://192.168.1.183:8080` | Backup. Flatbed only. |

**Note:** The `escl` SANE backend is disabled (`#escl` in `/etc/sane.d/dll.conf`). Canon uses `sane-airscan` only.

## Document Classification & Routing

Documents are auto-classified from OCR text and routed to Nextcloud folders. Classification is config-driven via `~/.ocr-mcp/routing-rules.json` — no code changes needed to add new rules.

### routing-rules.json structure

```json
{
  "properties": [
    {
      "address": "3320 chukar mortgage",
      "path": "/Personal/Housing/3320-Chukar/Mortage/",
      "keywords": ["rocket mortgage", "loan number 3544452112"]
    }
  ],
  "custom_rules": [
    {
      "keywords": ["w-2", "1099", "irs"],
      "type": "tax",
      "path": "/Personal/Financial/Taxes/{year}/",
      "detect_year": true
    }
  ]
}
```

**Priority order:**
1. `properties` — property/lender-specific routing (most specific)
2. `custom_rules` — keyword→path rules, supports `{year}` substitution
3. Hardcoded fallbacks (receipts, medical, insurance, auto, Theodore, etc.)
4. `/Inbox/` default

## Filename Generation

Files are named `YYYY-MM-DD_Title_Case_Slug.pdf` automatically from OCR content.

**Extraction priority:**
1. ALL-CAPS company name + next title-case line (e.g. `ROCKET MORTGAGE` + `Autopay Confirmation` → `Rocket_Mortgage_Autopay_Confirmation`)
2. Title-case or ALL-CAPS line from first 10 lines
3. First 5 non-stop-word tokens
4. `description` parameter (only if OCR finds nothing)
5. Classification type

## Requirements

- **Node.js 18+**
- **ocrmypdf** (`/usr/bin/ocrmypdf` v16.7.0+): `apt install ocrmypdf`
- **Tesseract**: `apt install tesseract-ocr`
- **ImageMagick**: `apt install imagemagick`
- **sane-utils + sane-airscan**: `apt install sane-utils sane-airscan`
- **polycr stack** (recommended): `http://192.168.1.11:8000` (OCR) and `:8001` (ocrmypdf service)

## Setup

```bash
npm install
```

Set environment variables (or configure in OpenClaw `openclaw.json` MCP server env block):

```
NEXTCLOUD_URL=https://your-nextcloud.example.com
NEXTCLOUD_USER=username
NEXTCLOUD_PASSWORD=app-password
POLYCR_HOST=192.168.1.11   # optional, default 192.168.1.11
```

Register in OpenClaw `~/.openclaw/openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "ocr": {
        "command": "node",
        "args": ["/home/david/ocr-mcp/index.mjs"],
        "requestTimeoutMs": 180000,
        "env": {
          "NEXTCLOUD_URL": "...",
          "NEXTCLOUD_USER": "...",
          "NEXTCLOUD_PASSWORD": "..."
        }
      }
    }
  }
}
```

## Related

- [polycr](../polycr) — multi-engine OCR backend
- `~/.ocr-mcp/routing-rules.json` — document routing config (outside this repo)
- `~/.openclaw/workspace/skills/document-scanning/SKILL.md` — OpenClaw skill instructions (outside this repo)
