# Scanning Profiles Reference

Scanner: HP OfficeJet 5740 at `escl:http://192.168.1.183:8080`  
Nextcloud WebDAV base: `https://nextcloud.shifting-ground.link/remote.php/dav/files/david.gutowsky`  
Credentials: from `openclaw.json` → `mcp.servers.nextcloud-files.env`

## All Profiles

| Profile | Mode | Source | Resolution | OCR | PDF | Typical Use |
|---------|------|--------|------------|-----|-----|-------------|
| `doc-bw` | Gray | Flatbed | 300 DPI | polycr | yes | Letters, bills, statements, contracts |
| `doc-bw-adf` | Gray | ADF | 300 DPI | polycr | yes | Multi-page B/W documents |
| `doc-color` | Color | Flatbed | 300 DPI | polycr | yes | Color forms, certificates |
| `receipt` | Gray | Flatbed | 300 DPI | polycr | yes | Receipts, invoices |
| `id-card` | Color | Flatbed | 300 DPI | polycr | yes | IDs, insurance cards, passports |
| `photo` | Color | Flatbed | 300 DPI | skip | no (keep JPEG) | Photographs, artwork |
| `event` | Color | Flatbed | 300 DPI | extract_event_details | no | Invites, flyers, RSVPs |

---

## Profile: `doc-bw`

**Use for:** Single-page letters, forms, bills, statements, contracts (black and white)

**Pipeline:**
1. `ocr__scan_document` — mode=Gray, source=Flatbed, resolution=300, format=jpeg
2. `ocr__ocr_image_polycr` — extract text
3. `ocr__create_searchable_pdf` — produce archival PDF
4. Confirm filename + path with David
5. WebDAV upload to Nextcloud → delete temp JPEG

**Extract from text:** date, sender/issuer, document type, subject

**Filename format:** `YYYY-MM-DD_issuer-description.pdf`  
Example: `2026-04-13_verizon-bill.pdf`

**Date rule:** use date found in document; fall back to today's date if none found

**Classification rules:**
| Document type | Filing path |
|---------------|-------------|
| Bill, statement | `/Personal/Financial/` |
| Medical record, EOB | `/Personal/Health/Medical/` |
| Insurance document | `/Personal/Insurance/` |
| Legal document | `/Personal/Legal/` |
| Tax document | `/Personal/Financial/Taxes/` |
| Anything else | `/Inbox/` |

---

## Profile: `doc-bw-adf`

**Use for:** Multi-page B/W documents via ADF feeder

**Pipeline:**
1. `ocr__scan_document` — mode=Gray, source=ADF, resolution=300, format=jpeg
2. Repeat for each page (ADF is single-pass; no duplex; one image per page)
3. `ocr__ocr_image_polycr` on each page
4. `ocr__create_searchable_pdf` — treat all pages as one document
5. Confirm filename + path with David
6. WebDAV upload → delete all temp JPEGs

**OCR + PDF + classification:** same as `doc-bw`

**Note:** ADF does not support duplex scanning. For two-sided documents, flip the stack and scan again as a second batch.

---

## Profile: `doc-color`

**Use for:** Color forms, certificates, anything where color carries meaning

**Pipeline:**
1. `ocr__scan_document` — mode=Color, source=Flatbed, resolution=300, format=jpeg
2. `ocr__ocr_image_polycr`
3. `ocr__create_searchable_pdf`
4. Confirm filename + path with David
5. WebDAV upload → delete temp JPEG

**OCR + PDF + classification:** same as `doc-bw`

---

## Profile: `receipt`

**Use for:** Store receipts, invoices, purchase confirmations

**Pipeline:**
1. `ocr__scan_document` — mode=Gray, source=Flatbed, resolution=300, format=jpeg
2. `ocr__ocr_image_polycr`
3. `ocr__create_searchable_pdf`
4. Show David: merchant name, date, total amount — confirm before filing
5. WebDAV upload → delete temp JPEG

**Extract:** merchant name, date, total amount

**Filename format:** `YYYY-MM-DD_receipt-merchant.pdf`  
Example: `2026-03-15_receipt-home-depot.pdf`

**Filing:** always `/Personal/Financial/Receipts/` — no classification needed

---

## Profile: `id-card`

**Use for:** Driver's license, insurance cards, membership cards, passport pages

**Pipeline:**
1. `ocr__scan_document` — mode=Color, source=Flatbed, resolution=300, format=jpeg
2. `ocr__ocr_image_polycr`
3. `ocr__create_searchable_pdf`
4. Confirm filename + path with David
5. WebDAV upload → delete temp JPEG

**Extract:** ID type, name on card, expiry date

**Filename format:** `YYYY-MM-DD_id-type-name.pdf`  
Example: `2026-04-13_insurance-card-david-gutowsky.pdf`

**Filing rules:**
| ID type | Filing path |
|---------|-------------|
| Driver's license, passport, SSN card | `/Personal/Identity/` |
| Insurance card | `/Personal/Insurance/` |
| Latvian ID or citizenship document | `/Personal/Identity/Latvian-Citizenship/` |

---

## Profile: `photo`

**Use for:** Photographs, artwork, images where no text is expected

**Pipeline:**
1. `ocr__scan_document` — mode=Color, source=Flatbed, resolution=300, format=jpeg
2. Skip OCR
3. Skip PDF — keep as JPEG
4. Ask David for a short description
5. WebDAV upload → delete original temp file (only the upload copy is retained)

**Filename format:** `YYYY-MM-DD_description.jpg`

**Filing:** always `/Media/Photos/`

---

## Profile: `event`

**Use for:** Party invitations, event flyers, RSVPs

**Pipeline:**
1. `ocr__scan_document` — mode=Color, source=Flatbed, resolution=300, format=jpeg
2. `ocr__extract_event_details` — handles orientation + classification in one call
3. No PDF, no Nextcloud filing — follow the event→calendar workflow in `workflows.md`
4. Output: calendar event confirmation

---

## General Rules (all profiles)

**Filename date:** use the date found in the document content. If none found, use today's date.

**Low confidence:** if OCR returns `word_count < 10` or `empty: true`:
1. Run `ocr__enhance_image_for_ocr` on the original JPEG
2. Retry `ocr__ocr_image_polycr` on the enhanced output
3. Only escalate to manual review after both attempts fail

**Always confirm before uploading:** show David the proposed filename and filing path and wait for approval before any WebDAV upload.

**Temp file cleanup:** after upload is confirmed, delete all temp JPEG files created during the scan session.

**Nextcloud credentials:** read from `openclaw.json` → `mcp.servers.nextcloud-files.env`
