# OCR MCP — Workflows & Full Tool Reference

> **Use `ocr__scan_and_file` for all scanning.** It executes the full pipeline atomically in one call, preventing context bootstrap interruptions.

## Scanning Pipeline Architecture

```
scan_document (ocr-mcp on openclaw host) → JPEG temp file
    ↓
polycr :8000/ocr/raw → multi-engine text extraction
    (purpose: document classification + filename generation)
    ↓
ocrmypdf-service :8001/pdf → searchable PDF with embedded text layer
    (purpose: archival document with copy/search capability)
    ↓
Upload to Nextcloud via WebDAV
    ↓
Delete temp files
```

Three services participate in every document scan:

| Service | Host | Port | Role |
|---------|------|------|------|
| ocr-mcp | openclaw (192.168.1.x) | stdio | MCP server; drives the pipeline |
| polycr router | 192.168.1.11 | 8000 | Multi-engine OCR for text extraction |
| ocrmypdf | 192.168.1.11 | 8001 | Searchable PDF generation for archival |

---

## Scanning Profiles

Scanner: HP OfficeJet 5740 at `escl:http://192.168.1.183:8080` — 300 DPI, no duplex.

| Profile | Mode | Source | Format | OCR | Use case |
|---------|------|--------|--------|-----|----------|
| `doc-bw` | Gray | Flatbed | PDF | Yes | Single-page letters, forms, contracts |
| `doc-bw-adf` | Gray | ADF | PDF | Yes | Multi-page B/W via feeder |
| `doc-color` | Color | Flatbed | PDF | Yes | Color forms, certificates |
| `receipt` | Gray | Flatbed | PDF | Yes + structured extraction | Receipts, invoices |
| `id-card` | Color | Flatbed | PDF | Yes | IDs, insurance cards, wallet items |
| `photo` | Color | Flatbed | JPEG | No | Photos, artwork |
| `event` | Color | Flatbed | — | extract_event_details → calendar | Invites, flyers |

---

## Filename Convention

Format: `YYYY-MM-DD_description.pdf`

- Date: extracted from document content if present, otherwise use scan date.
- Description: auto-generated from OCR text (2–5 word summary, lowercase-hyphenated).

Examples:
- `2026-03-15_att-phone-bill.pdf`
- `2026-04-01_state-farm-renewal.pdf`
- `2026-04-13_scan.pdf` (fallback when content is not extractable)

---

## Tool Reference

| Tool | Use Case | Returns |
|------|----------|---------|
| `ocr__extract_event_details` | Invite, flyer, birthday card, RSVP | `{ raw_text, engine_used, confidence, word_count, likely_document_type, document_signals[] }` |
| `ocr__ocr_image_polycr` | Best-quality OCR on a local file | `{ text, engine_used, confidence, word_count, empty, fallback_reason? }` |
| `ocr__ocr_image_local` | Quick local extraction, no network | `{ text, word_count, empty }` |
| `ocr__ocr_image_from_base64` | Base64 image data | same as polycr |
| `ocr__ocr_image_from_url` | Image at a URL (20MB limit) | same as polycr |
| `ocr__auto_orient_image` | Fix sideways photo (EXIF rotation) | output file path |
| `ocr__rotate_image` | Rotate by explicit degrees (90/180/270) | output file path |
| `ocr__enhance_image_for_ocr` | Preprocess low-contrast image | output file path |

---

## Workflow: Event Invite → Calendar Event

**Step 1 — OCR**
Call `ocr__extract_event_details` with the image file path. Do not call auto_orient first — extract_event_details handles orientation internally.

**Step 2 — Parse raw_text**
Extract from `raw_text`:
- **Title** — whose party / what event
- **Date** — convert to ISO 8601 ("Saturday May 3rd" → "2026-05-03")
- **Start time** — ISO 8601 datetime ("3:00 PM" → "2026-05-03T15:00:00")
- **End time** — if not stated, assume 2 hours after start
- **Location** — full address or venue name
- **RSVP** — deadline and contact if present

If year not stated, use next upcoming occurrence.

**Step 3 — Confirm with David**
```
Found: Emma's Birthday Party
Date: Saturday May 3, 2026 at 3:00 PM
Location: 123 Oak Street, Chicago IL
RSVP: by April 28 to sarah@email.com

Create this event?
```

**Step 4 — Create event**
Call `fastmail__create_calendar_event`:
- `title`, `start`, `end`, `location`, `description` (RSVP + extras)

If confidence < 0.6 or word_count < 15: show raw_text and ask David to confirm fields first.

---

## Workflow: Low-Quality or Unreadable Image

If `empty: true` or `word_count < 10` after `ocr_image_polycr`:
1. Call `ocr__enhance_image_for_ocr` on the original file
2. Retry `ocr__ocr_image_polycr` on the enhanced output
3. If still empty, fall back to vision analysis
4. Never say "I can't read this" without completing all three steps first

---

## Workflow: Rotation Fix

1. Call `ocr__auto_orient_image` — fixes EXIF rotation automatically
2. If still wrong, call `ocr__rotate_image` with explicit degrees (90, 180, or 270)
3. After rotating, always run OCR and show extracted text to confirm

---

## Workflow: Document Scanning → Nextcloud Filing

Full end-to-end flow when David scans a document for archival:

**Step 1 — Scan**
Call `ocr__scan_document` with appropriate mode and source. Save to a temp path (e.g. `/tmp/scan_<timestamp>.jpg`).

**Step 2 — Extract text for classification**
Call `ocr__ocr_image_polycr` on the scanned file. Use the returned text to:
- Classify the document type (receipt, medical, insurance, legal, tax, identity, housing, auto, etc.)
- Extract a date (prefer date found in document content over scan date)
- Generate a short description (2–5 words, lowercase-hyphenated)

**Step 3 — Generate searchable PDF**
Call `ocr__create_searchable_pdf` on the scanned file. This produces a PDF with an embedded text layer at the same path with a `.pdf` extension.

**Step 4 — Determine Nextcloud filing location**

| Document type | Nextcloud path |
|---------------|---------------|
| Receipts, invoices | `/Personal/Financial/Receipts/` |
| Tax documents | `/Personal/Financial/Taxes/` |
| Medical records | `/Personal/Health/Medical/` |
| Insurance documents | `/Personal/Insurance/` |
| Legal / contracts | `/Personal/Legal/` |
| Identity documents | `/Personal/Identity/` |
| Theodore (child docs) | `/Personal/Theodore/` |
| Housing | `/Personal/Housing/` |
| Auto | `/Personal/Auto/` |
| Photos | `/Media/Photos/` |
| Unknown / ambiguous | `/Inbox/` |

If classification is ambiguous, ask David before filing.

**Step 5 — Upload**
Upload the PDF to the determined Nextcloud path via WebDAV.
Filename: `YYYY-MM-DD_description.pdf` (see Filename Convention section above).

**Step 6 — Cleanup**
Delete the temp JPEG and any intermediate files.

---

## Decision Table

| Scenario | Tool |
|----------|------|
| Invite, flyer, birthday card, RSVP | `ocr__extract_event_details` |
| Best-quality OCR on a local file | `ocr__ocr_image_polycr` |
| Quick local, no network | `ocr__ocr_image_local` |
| Base64 image data | `ocr__ocr_image_from_base64` |
| Image at a URL | `ocr__ocr_image_from_url` |
| Fix sideways photo | `ocr__auto_orient_image` |
| Rotate by specific degrees | `ocr__rotate_image` |
| Preprocess low-contrast image | `ocr__enhance_image_for_ocr` |
