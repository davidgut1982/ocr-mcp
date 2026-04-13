# ocr-mcp

An MCP (Model Context Protocol) server for OCR and document scanning. Exposes 10 tools via the `@modelcontextprotocol/sdk` for image text extraction, preprocessing, document scanning, and searchable PDF generation. Used with OpenClaw (an AI assistant gateway) via Telegram.

## Architecture

Three services form the document scanning stack:

```
scan_document (this server) → JPEG temp file
    ↓
polycr :8000  — multi-engine OCR for text extraction and classification
    ↓
ocrmypdf :8001 — searchable PDF generation for archival
    ↓
Nextcloud (WebDAV)
```

Both polycr and ocrmypdf run as Docker Compose services on the OCR host (default: `192.168.1.11`).

## Tools

| Tool | Description |
|------|-------------|
| `ocr__scan_document` | Scan from the HP OfficeJet 5740 (flatbed or ADF) at 300 DPI. |
| `ocr__create_searchable_pdf` | Convert a scanned image to a searchable PDF via the ocrmypdf service (port 8001). Falls back to local Tesseract if the service is unreachable. |
| `ocr__ocr_image_polycr` | Multi-engine OCR via the polycr stack (tesseract/easyocr/doctr) running on a remote host (default: `http://192.168.1.11:8000`). Falls back to local Tesseract if the polycr endpoint is unreachable. |
| `ocr__ocr_image_local` | OCR using local Tesseract only — no network dependency. |
| `ocr__ocr_image_from_base64` | Accept a base64-encoded image and run OCR on it. |
| `ocr__ocr_image_from_url` | Download an image from a URL and run OCR on it. |
| `ocr__extract_event_details` | Auto-orient the image, run OCR, and classify the document (invites, flyers, etc.) to extract structured event details. |
| `ocr__auto_orient_image` | Fix image rotation based on EXIF metadata. |
| `ocr__rotate_image` | Rotate an image by an explicit number of degrees. |
| `ocr__enhance_image_for_ocr` | Preprocess an image (contrast, sharpening, binarization) to improve OCR accuracy. |

## Requirements

- **Node.js 18+**
- **Local Tesseract** (required for local fallback and `ocr__ocr_image_local`):
  ```bash
  apt install tesseract-ocr
  ```
- **polycr stack** (optional, for multi-engine OCR): a running instance of the polycr HTTP service. Default endpoint is `http://192.168.1.11:8000`. If unavailable, tools that use polycr fall back to local Tesseract.

## Locally Installed Software

These packages are installed on the host machine and used directly by this server:

| Package | Version | Purpose |
|---------|---------|---------|
| `tesseract-ocr` | 5.5.0 | Local OCR engine — used by `ocr__ocr_image_local` and as polycr fallback |
| `sane-utils` | 1.3.1 | `scanimage` CLI — scanner access layer (SANE) |
| `sane-airscan` | 0.99.35 | eSCL/AirScan backend — enables network scanning from HP and other AirScan-compatible scanners |
| `imagemagick` | 7.1.1.43 | Image preprocessing — used by `ocr__enhance_image_for_ocr`, `ocr__rotate_image`, `ocr__auto_orient_image` |

**Scanner configuration (HP OfficeJet 5740):**
```bash
# Device string for scanimage
escl:http://192.168.1.183:8080

# Basic flatbed scan
scanimage --device-name="escl:http://192.168.1.183:8080" \
  --format=jpeg --output-file=/tmp/scan.jpg --resolution=300
```

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set `POLYCR_HOST` (default `192.168.1.11`) if your OCR host is at a different address. Both the polycr (port 8000) and ocrmypdf (port 8001) service URLs are derived from this value.

3. Register the server in your OpenClaw MCP config (typically `~/.config/openclaw/mcp.json` or equivalent):
   ```json
   {
     "servers": {
       "ocr": {
         "command": "node",
         "args": ["/path/to/ocr-mcp/index.mjs"]
       }
     }
   }
   ```

## Related

- [polycr](https://github.com/davidgut1982/polycr) — the multi-engine OCR backend this server calls for `ocr__ocr_image_polycr` and `ocr__extract_event_details`

## Documentation

The `docs/workflows.md` file contains full workflow documentation for OpenClaw/SOUL.md integration, including how the OCR tools are composed into higher-level assistant behaviors.
