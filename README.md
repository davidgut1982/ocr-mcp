# ocr-mcp

An MCP (Model Context Protocol) server for OCR. Exposes 8 tools via the `@modelcontextprotocol/sdk` for image text extraction, preprocessing, and document classification. Used with OpenClaw (an AI assistant gateway) via Telegram.

## Tools

| Tool | Description |
|------|-------------|
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

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure the polycr endpoint (if different from the default `http://192.168.1.11:8000`) by editing the constant at the top of `index.mjs`.

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

## Documentation

The `docs/workflows.md` file contains full workflow documentation for OpenClaw/SOUL.md integration, including how the OCR tools are composed into higher-level assistant behaviors.
