---
name: scanning
description: "Scan physical documents via Canon MF741C or HP scanner and file to Nextcloud. Also OCRs images attached in chat — call ocr__ocr_inbound_media immediately when [media attached:] appears."
triggers:
  - scan
  - scan this
  - scan and file
  - file this
  - scanning
  - scanner
  - ADF
  - flatbed
  - quick scan
  - ocr this
  - ocr
  - read this image
  - read this photo
  - extract text
  - what does this say
  - attached image
  - attached photo
  - pdf
  - document
  - documents
  - split
  - split and refile
  - separate pages
  - break apart
  - refile
---

> **CRITICAL**: The `ocr__*` tools are completely self-contained. They communicate
> directly with the scanner over HTTP (eSCL protocol). **Do NOT check, mention, or
> touch any of the following — they are irrelevant:**
> - `saned` or the SANE daemon
> - `scanimage` or any SANE-based utility
> - System services, daemons, or `systemctl`
> - `/dev/scanner`, USB devices, or kernel drivers
>
> If you think a system service needs to be started or checked before scanning,
> you are wrong. Call the tool. It handles everything.

> Note: `docs/scanning-profiles.md` describes low-level individual tools (`ocr__scan_document`, `ocr__ocr_image_polycr`, etc.). When using `ocr__scan_and_file` or `ocr__quick_scan` the pipeline runs automatically — do not call intermediate tools manually.

# Document Scanning & Filing

## Canon MF741C hardware note

The Canon ADF always produces Color output regardless of profile. The `doc-bw-adf` profile requests Gray but the hardware overrides to Color. This is expected — do not treat it as an error or report it to the user.

---

## Decision tree — pick a path, don't ask

### Profile selection

| What David says | Profile |
|---|---|
| letter, form, bill, contract, statement | `doc-bw` |
| multi-page document, stack of papers | `doc-bw-adf` |
| color form, certificate, color doc | `doc-color` |
| receipt, invoice | `receipt` |
| ID, license, insurance card, passport | `id-card` |
| photo, picture, image | `photo` |
| invite, flyer, event | `event` |

Default call format:
```
ocr__scan_and_file(profile="<profile>", description="<optional hint>")
```
When scanning multiple separate documents, add `separate_pages=true`.

Pass `filename` to override the auto-generated name entirely (only when the user provides an explicit filename, e.g. `"2026-04-13_verizon-bill.pdf"`).

---

### Attached image in chat
When `[media attached: media://inbound/<id>]` appears in the message:
1. **Immediately call `ocr__ocr_inbound_media`** — extract `<id>` and pass as `media_id`
2. If no marker visible, call `ocr__ocr_inbound_media` with no arguments (uses most recent upload)
3. Report extracted text to user
4. To also file to Nextcloud: pass `file_nextcloud: true` and optionally `description`

**Do NOT use vision capabilities** to read attached images — always use `ocr__ocr_inbound_media` so it goes through the polycr OCR engine.

### Single document in ADF / unspecified scan request (default)
- Call `ocr__quick_scan()` immediately — no questions. Pass `description` only if the user explicitly names the document; otherwise omit it.
- Do NOT invent descriptions
- `quick_scan` treats the entire ADF contents as one multi-page document

### Stack of separate documents in ADF
- Any time the user says "documents" (plural), "scan everything", "scan all", "scan the stack", or similar — use `separate_pages: true`
- Call `ocr__scan_and_file` with `profile: "doc-bw-adf"` and `separate_pages: true`
- Each page gets its own PDF and is classified/filed independently
- **Default assumption for ADF**: if you don't know whether it's one document or many, use `separate_pages: true` — a merged multi-page PDF can't be unsplit, but separate single-page PDFs can always be recombined

Pages with fewer than 10 words trigger an automatic image enhancement retry. If the page still has sparse text it will land in `/Inbox/` — flag it to the user as usual.

### Flatbed single page
- Call `ocr__scan_and_file` with `profile: "doc-bw"`
- Default scanner: `canon-mf741c`

### User specifies a destination folder
- Pass `nextcloud_path` with the exact folder (include trailing slash)
- Still use ADF + `ocr__quick_scan` or `ocr__scan_and_file` unless user says flatbed

### User specifies an exact filename
- Pass `filename` with the exact name including `.pdf` extension
- Still use whichever profile and scanner are appropriate for the content

### HP scanner (user says "HP" or Canon unreachable)
- Call `ocr__scan_and_file` with `scanner: "hp-officejet-5740"` and `profile: "doc-bw"`

### Special profiles
| User says | Profile |
|-----------|---------|
| "color" / "in color" | `doc-color` |
| "receipt" | `receipt` |
| "ID card" / "insurance card" | `id-card` |
| "photo" | `photo` |

---

## Scanners

| ID | Name | Notes |
|----|------|-------|
| `canon-mf741c` | Canon MF741C | Primary. ADF + flatbed. IP: 192.168.1.141 |
| `hp-officejet-5740` | HP Officejet 5740 | Backup. Flatbed only. IP: 192.168.1.183 |

## Profiles

| Profile | Mode | Source | Use for |
|---------|------|--------|---------|
| `doc-bw-adf` | Gray (outputs Color on Canon) | ADF | Multi-page ADF batches — default |
| `doc-bw` | Gray | Flatbed | Single page flatbed |
| `doc-color` | Color | Flatbed | Color documents |
| `receipt` | Gray | Flatbed | Receipts |
| `id-card` | Color | Flatbed | ID cards, insurance cards |
| `photo` | Color | Flatbed | Photos |

---

## Auto-classification routing

The MCP reads OCR text and routes to the correct Nextcloud folder automatically. **Custom rules are checked first, then property rules. This prevents a home address appearing on a bill from routing to a housing folder when a more-specific document-type rule (e.g. Subaru) should win.**

**Properties (checked after custom rules):**
- "rocket mortgage" or "loan number 3544452112" → `/Personal/Housing/3320-Chukar/Mortgage/`
- "3320 chukar" or "woodstock, il 60098" → `/Personal/Housing/3320-Chukar/`
- "10810 pheasant" → `/Personal/Housing/10810-Pheasant/` Also matches the bare word "pheasant" alone.

**All other rules:**
- W-2, 1099, 1040, IRS, adjusted gross income, federal income tax → `/Personal/Financial/Taxes/{year}/`
- Subaru, Subaru Outback → `/Personal/Auto/Subaru Outback/`

> The Subaru Outback rule also matches "decraenes", "decraene's", and "de craenes" (the service shop name). Documents from DeCraenes Service Center will file to /Personal/Auto/Subaru Outback/ automatically.

- Toyota Tundra, Tundra → `/Personal/Auto/Toyota Tundra/`
- Bankruptcy, chapter 7, chapter 13, trustee, Hibbs → `/Personal/Legal/Genna/`
- Unemployment, IDES, Illinois Department of Employment → `/Personal/Job/Unemployment/`
- FSA, flexible spending, HSA, health savings → `/Personal/Insurance/FSA/`
- Student loan, Sallie Mae, Navient, Nelnet → `/Personal/Financial/Student-Loans/`
- Credit card, Discover, Chase Sapphire, Capital One, Citi, Amex → `/Personal/Financial/Credit-Cards/`
- ComEd, Nicor Gas, Peoples Gas, Ameren, electric bill, gas bill → `/Personal/Financial/Utilities/`
- Verizon, AT&T wireless, T-Mobile, Comcast, Xfinity, Spectrum → `/Personal/Financial/Utilities/Phone-Internet/`
- Chase Bank, US Bank, BMO Harris, bank statement, checking account → `/Personal/Financial/Banking/`
- EOB, explanation of benefits, copay, coinsurance, in-network → `/Personal/Health/Insurance-EOB/`
- Theodore, Teddy Gutowsky, daycare, preschool, kindergarten, immunization, vaccination → `/Personal/Theodore/`
- Unrecognized → `/Inbox/`

---

## Splitting an already-filed PDF into separate documents

When the user asks to split, separate, or break apart a PDF that's already in Nextcloud:

1. **Immediately call `ocr__split_and_refile`** — do not describe what you're about to do, do not ask for confirmation, just call it.
2. Pass `source_path` as the full Nextcloud path including filename.
3. Pass `delete_original: true` only if the user explicitly says to delete or remove the original.
4. Pass `description` if the user names the document type (e.g. "DeCraenes invoice").

If any page fails to refile, the original is preserved regardless of `delete_original`. Always check `pages_succeeded` vs `pages_processed` in the response.

**Do NOT say things like "I don't have direct access" or "let me know if that works" — the tool handles the download, split, OCR, classify, and upload automatically.**

After the tool returns, report each page's `filed_at` and `filename`. Flag any pages that landed in `/Inbox/`.

Also report:
- `pages_processed` / `pages_succeeded` — note any failures
- `original_deleted` — confirm if user requested deletion
- `delete_note` — if present, report it
- Any page with `note: "Could not classify — filed to /Inbox/"` — flag for user action

---

## After scanning — always report

- `filed_at` — full Nextcloud path
- `filename` — generated filename
- `pages` — page count
- One-line OCR preview
- `date` — always report the document date in ISO format (`YYYY-MM-DD`). If the document has no date, use today's date.
- `confidence` — a 0–1 score. If `confidence < 0.5` AND `word_count < 20`, warn the user that OCR quality may be unreliable. Do NOT call `ocr__enhance_image_for_ocr` manually — enhancement runs automatically.
- `filed_at` will be `null` for the `event` profile — event documents are not uploaded to Nextcloud. Do not report "filed to null"; proceed with the event→calendar workflow instead.

If filename looks wrong — check for these indicators:
- Contains generic words: "scan", "retry", "paper", "document", "flatbed"
- Looks like an address fragment: contains "Drive", "Street", "Ave", "Road", "Blvd", "Lane", "Court", or starts with a street number
- Looks like a form label: "Phone_No", "Received_By", "Description_Of_Work", "Job_Location", single-word technical terms
- Too short (1 word) or too generic (just a type like "Invoice", "Receipt", "Statement" with no vendor name)
- Date portion is not ISO format (`YYYY-MM-DD`) or is clearly wrong (year outside 1990–2099)

Then:
1. Report the filed path and what the filename looks like
2. Suggest a better name based on the OCR content (vendor name + document type)
3. Offer to rename using `ocr__nextcloud_move`
4. If user agrees, call `ocr__nextcloud_move` with the corrected filename

---

## Error handling

| Error | Action |
|-------|--------|
| `"Not connected"` | The MCP server is cold-starting (lazy spawn, takes 1–2 sec). **Call the exact same tool again immediately with identical parameters.** It resolves on the second attempt. Do NOT check saned, scanimage, or any system service. |
| ADF feeder empty (0 pages) | Ask user to load paper and confirm pages are seated; retry once |
| "Error during device I/O" / scanner timeout | Canon is in Auto Shutdown sleep. Tell user to press any button on the printer. Suggest permanent fix: Menu → Preferences → Timer/Energy Settings → Auto Shutdown Time → Off |
| "Invalid argument" | Try `profile: "doc-color"` or switch to flatbed |
| No files in media/inbound | User hasn't attached an image yet; ask them to attach one |
| `merged-no-ocr` in `pdf_method` result | Scan succeeded but all OCR methods failed — file is uploaded but has no searchable text layer. Tell the user: "The document was filed but the PDF is not searchable. You may want to re-scan." |
| `source_path must point to a .pdf file` | Path passed to `split_and_refile` doesn't end in `.pdf`. Correct the path and retry. |
| `This PDF has only 1 page — nothing to split` | Use `ocr__nextcloud_move` to rename or refile it instead. |
| `Nextcloud download failed: HTTP 404` | File not found — check `source_path` spelling and case. |
| `Nextcloud upload failed: HTTP 507` | Nextcloud storage quota exceeded. |
| `polycr service HTTP 5xx` | Remote OCR service is down. Pipeline automatically falls back to local Tesseract — scan will still complete. |
| Agent mentions saned / scanimage / SANE daemon | That is wrong. Call `ocr__quick_scan` immediately. |

---

## `pdf_method` values

| Value | Meaning |
|-------|---------|
| `polycr` | Full-quality searchable PDF from the remote OCR service |
| `ocrmypdf-local` | Searchable PDF from local ocrmypdf CLI (remote service unavailable) |
| `tesseract-local` | Searchable PDF from local Tesseract fallback — quality may be lower |
| `merged-no-ocr` | All PDF methods failed — file uploaded but not searchable |
| `jpeg-only` | Photo or event profile — a JPEG was filed, not a PDF |
| `existing-text-layer` | (split_and_refile only) Page already had an embedded text layer; no re-OCR needed |

---

## Hard rules
- Never mention saned, scanimage, SANE, or any system daemon — they are not part of this pipeline
- Never ask about or attempt to manage system services — the ocr__ tools communicate directly with the scanner via HTTP
- Never ask which scanner to use
- Never ask which profile to use
- Never ask for a Nextcloud folder unless the document lands in `/Inbox/`
- Never ask whether to OCR — always OCR
- If a document lands in `/Inbox/`, flag it: "Filed to /Inbox/ — I couldn't classify this one. Where should it go?"
- Do not re-confirm the user's request before scanning — just scan
- **Prior failures do not exempt you from trying again.** If the user asks to scan, call the tool. Every time. A previous timeout or feeder-empty error does not mean the hardware is still in that state — the user may have reloaded paper or the scanner may have recovered. Never skip the tool call based on conversation history.
- **Never report "ADF not detecting pages" without calling the scan tool first.** That conclusion requires evidence from an actual tool call, not inference from prior context.
- **Never try to split PDFs yourself.** If the user asks to split or separate an existing PDF, call `ocr__split_and_refile` immediately. Do not reason about whether utilities are installed, do not ask for confirmation, do not describe what you're about to do. The tool handles everything — download, split (using Ghostscript, which is installed), OCR, classify, and refile. Just call it.
- **If any `ocr__*` tool returns `"Not connected"`, retry that exact tool call once immediately.** Never interpret this as a scanner hardware problem or system service problem.
