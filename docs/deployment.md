# Deployment Guide

Combined deployment guide for the polycr + ocrmypdf + ocr-mcp stack.

- **polycr** (port 8000) and **ocrmypdf** (port 8001) run on the dedicated OCR host (192.168.1.11) as Docker Compose services.
- **ocr-mcp** runs on the assistant host alongside OpenClaw.

---

## Prerequisites

Both hosts require the following before proceeding.

**OCR host (192.168.1.11):**
- Docker Engine 24+ with Compose v2 plugin
- `curl` for health checks

**Assistant host (where OpenClaw runs):**
- Node.js 18+
- `tesseract-ocr` (local fallback OCR)
  ```bash
  apt install tesseract-ocr
  ```
- `sane-utils` and `sane-airscan` (scanner access)
  ```bash
  apt install sane-utils sane-airscan
  ```
- `imagemagick` (image preprocessing)
  ```bash
  apt install imagemagick
  ```

---

## Step 1 — Deploy polycr on the OCR host (192.168.1.11)

polycr is the multi-engine OCR backend. It must be running and reachable before ocr-mcp will use multi-engine OCR.

```bash
# Clone the repository
git clone https://github.com/davidgut1982/polycr.git
cd polycr

# Configure environment
cp .env.example .env
# Edit .env — set LLM_API_KEY at minimum
# LLM_PROVIDER defaults to anthropic; adjust if needed

# Start the default stack (tesseract + easyocr + doctr)
docker compose up -d

# Tail logs until services are healthy (~60 s on first run while models download)
docker compose logs -f
```

Verify both services are running:
```bash
curl http://192.168.1.11:8000/health
# Expected: {"status":"ok","engines":["tesseract","easyocr","doctr"]}

curl http://192.168.1.11:8001/health
# Expected: {"status":"ok","service":"ocrmypdf"}
```

If the health check returns a non-200 response or connection is refused, check `docker compose ps` and `docker compose logs` on the OCR host before proceeding.

The ocrmypdf service runs on port 8001 alongside polycr on port 8000. Both are started by `docker compose up -d` from the polycr repository root.

---

## Step 2 — Install ocr-mcp on the assistant host

```bash
# Clone the repository
git clone https://github.com/davidgut1982/ocr-mcp.git
cd ocr-mcp

# Install Node dependencies
npm install
```

Set environment variables (see table below). The simplest approach is to export them in your shell profile or pass them directly in the MCP config (Step 3).

```bash
export POLYCR_URL=http://192.168.1.11:8000
export SCANNER_DEVICE="escl:http://192.168.1.183:8080"
```

---

## Step 3 — Register ocr-mcp in OpenClaw MCP config

Add the server entry to your OpenClaw MCP configuration file (typically `~/.config/openclaw/mcp.json` or the path your OpenClaw installation uses):

```json
{
  "servers": {
    "ocr": {
      "command": "node",
      "args": ["/absolute/path/to/ocr-mcp/index.mjs"],
      "env": {
        "POLYCR_URL": "http://192.168.1.11:8000",
        "SCANNER_DEVICE": "escl:http://192.168.1.183:8080"
      }
    }
  }
}
```

Replace `/absolute/path/to/ocr-mcp` with the actual clone path. Restart OpenClaw after saving the config.

---

## Step 4 — Verify end-to-end with a test image

With polycr running on the OCR host and ocr-mcp registered in OpenClaw, send a test image through the full stack:

```bash
# Direct API test — bypasses ocr-mcp, confirms polycr is reachable
curl -X POST http://192.168.1.11:8000/ocr/raw \
  -F "file=@/path/to/test-image.jpg" | jq '.results[] | {engine, confidence}'

# Via OpenClaw — confirm the MCP tool is available
# Ask OpenClaw: "Use ocr__ocr_image_polycr to read /path/to/test-image.jpg"
```

Expected `/ocr/raw` response shape:
```json
{
  "results": [
    {"engine": "tesseract", "text": "...", "confidence": 87.3, "error": ""},
    {"engine": "easyocr",   "text": "...", "confidence": 91.2, "error": ""},
    {"engine": "doctr",     "text": "...", "confidence": 89.0, "error": ""}
  ]
}
```

If `ocr__ocr_image_polycr` returns results sourced only from tesseract, polycr is unreachable and the tool has fallen back to local Tesseract. Recheck Step 1.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POLYCR_HOST` | `192.168.1.11` | IP/hostname of the OCR host; used to derive both service URLs |
| `POLYCR_URL` | `http://<POLYCR_HOST>:8000` | Base URL of the polycr text extraction API (overrides POLYCR_HOST if set) |
| `SCANNER_DEVICE` | `escl:http://192.168.1.183:8080` | SANE device string passed to `scanimage` |

---

## Scanner Reference

| Scanner | IP | SANE device string |
|---------|----|--------------------|
| HP OfficeJet 5740 | 192.168.1.183 | `escl:http://192.168.1.183:8080` |
| HP OfficeJet Pro 8720 | 192.168.1.177 | `escl:http://192.168.1.177:8080` |

To list all available scanners detected on the network:
```bash
scanimage -L
```

Basic flatbed scan (HP OfficeJet 5740):
```bash
scanimage --device-name="escl:http://192.168.1.183:8080" \
  --format=jpeg --output-file=/tmp/scan.jpg --resolution=300
```
