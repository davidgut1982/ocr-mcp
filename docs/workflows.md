# OCR MCP — Workflows & Full Tool Reference

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

## Workflow: Document → Nextcloud Filing

When David scans a document to file it:
1. OCR with `ocr__ocr_image_polycr`
2. Classify document type from text (receipt, contract, medical, insurance, invoice, etc.)
3. Ask David where to file if classification is ambiguous — location depends on type
4. Upload to appropriate Nextcloud folder
5. Filename: `YYYY-MM-DD_document-description.pdf`

Common filing locations (confirm with David for new categories):
- Receipts → `/Documents/Receipts/YYYY/`
- Medical → `/Documents/Medical/`
- Insurance → `/Documents/Insurance/`
- Contracts/Legal → `/Documents/Legal/`
- Financial → `/Documents/Financial/`

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
