# ocr-mcp Change Log

## Session: 2026-04-16 — Full pipeline hardening, Canon MF741C, web GUI OCR

### New Tools

**`ocr__quick_scan`**
Zero-parameter scan-and-file alias. Uses Canon MF741C + `doc-bw-adf` profile by default. Designed for OpenClaw "scan this" / "quick scan" invocations with no clarifying questions.

**`ocr__nextcloud_move`**
WebDAV MOVE tool. Renames or moves a file already filed in Nextcloud without re-scanning. Used by OpenClaw to correct badly generated filenames after the fact.

**`ocr__ocr_inbound_media`**
Processes images attached via the OpenClaw web GUI. When a user attaches a photo in the browser, OpenClaw saves it to `~/.openclaw/media/inbound/`. This tool reads the file from that directory (by `media_id` or most-recent fallback) and runs it through polycr. This bypasses the need for model vision capability — works on free/text-only models.

### Bug Fixes

**Multi-page ADF PDF path: missing magic-byte guard**
The multi-page merge path (`pageJpegs.length > 1`) was writing polycr responses directly to disk without checking the `%PDF-` magic bytes. If polycr returned a JSON error body with HTTP 200 (e.g. on a DPI error), the corrupt response was uploaded to Nextcloud as a PDF with no text layer. Fixed: same `%PDF-` guard applied as the single-page path.

**Multi-page ADF PDF path: missing `--rotate-pages` and `--image-dpi 300`**
The local `ocrmypdf` CLI fallback in the multi-page path was missing `--rotate-pages` and `--image-dpi 300`. Scanned pages would be upside-down when polycr was unavailable. Fixed: flags now match the single-page path.

**Canon airscan: hostname vs direct IP**
`/etc/sane.d/airscan.conf` was configured with the mDNS hostname `Canoncb29e8.internal.shifting-ground.link`. SANE's mDNS stack could resolve it for device enumeration (`scanimage -L`) but plain HTTP connections (curl, the eSCL fetch) could not. Fixed: changed to direct IP `http://192.168.1.141/eSCL`.

### Improvements

**Filename generation: OCR-first slug priority**
Previously `description` parameter overrode OCR title extraction. If OpenClaw passed a generic description like "paper flatbed scan retry" the filename became that string. Fixed: `extractTitleSlug(text)` runs first; `description` is only used when OCR finds nothing.

**Filename format: `Title_Case_Underscores`**
Slug formatter changed from `all-lowercase-hyphens` to `Title_Case_With_Underscores` to produce readable names like `2025-11-15_Rocket_Mortgage_Autopay_Confirmation.pdf`.

**`extractTitleSlug`: Heuristic 0 — company + document type**
Added a new top-priority heuristic that finds an ALL-CAPS company name line (1–4 words, first 10 lines) and combines it with the next meaningful title-case line (1–5 words, within 3 lines). Produces `"ROCKET MORTGAGE Autopay Confirmation"` → `Rocket_Mortgage_Autopay_Confirmation` instead of just `Rocket_Mortgage`.

**routing-rules.json: expanded to 13 rules**
Added rules for:
- Energy utilities (ComEd, Nicor Gas, Peoples Gas, Ameren) → `/Personal/Financial/Utilities/`
- Phone/Internet (Verizon, AT&T, T-Mobile, Comcast, Xfinity) → `/Personal/Financial/Utilities/Phone-Internet/`
- Bank statements (Chase, US Bank, BMO) → `/Personal/Financial/Banking/`
- Insurance EOBs (explanation of benefits, deductible, copay) → `/Personal/Health/Insurance-EOB/`
- Theodore (daycare, preschool, immunization) → `/Personal/Theodore/`

### Infrastructure

**Canon MF741C added as primary scanner**
- Device string: `airscan:e0:Canon MF741C`
- Configured via `/etc/sane.d/airscan.conf` with direct IP `http://192.168.1.141/eSCL`
- `escl` backend disabled in `/etc/sane.d/dll.conf` to prevent conflicts
- Canon ADF requires `Color` mode (Gray returns "Invalid argument"); mode override applied automatically when `scanner=canon-mf741c` and `source=ADF`
- Canon has an Auto Shutdown feature that cuts network access entirely. Disable via: Menu → Preferences → Timer/Energy Settings → Auto Shutdown Time → Off

**OpenClaw SKILL.md**
Located at `~/.openclaw/workspace/skills/document-scanning/SKILL.md`. Injected into OpenClaw system prompt on gateway startup. Key behaviors:
- Default: call `ocr__quick_scan` immediately on any scan request, no clarifying questions
- Web GUI attachments: call `ocr__ocr_inbound_media` with the `media_id` from the message marker
- Filename format guidance: offer `ocr__nextcloud_move` if slug looks generic
- Error handling: Canon Auto Shutdown, ADF empty, Invalid argument fallback
