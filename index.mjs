import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { promisify } from "util";
import { execFile } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

const execFileAsync = promisify(execFile);

const POLYCR_HOST = process.env.POLYCR_HOST || '192.168.1.11';
const POLYCR_URL = process.env.POLYCR_URL || `http://${POLYCR_HOST}:8000`;
const POLYCR_PDF_URL = `http://${POLYCR_HOST}:8001`;
const SCANNER_DEVICE = process.env.SCANNER_DEVICE || 'escl:http://192.168.1.183:8080';

const SCANNERS = {
  'hp-officejet-5740': process.env.SCANNER_DEVICE || 'escl:http://192.168.1.183:8080',
  'canon-mf741c':      'airscan:e0:Canon MF741C',
};
// Default scanner (backward compat)
const DEFAULT_SCANNER = SCANNERS['hp-officejet-5740'];

const NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'https://nextcloud.shifting-ground.link';
const NEXTCLOUD_USER = process.env.NEXTCLOUD_USER || 'david.gutowsky';
const NEXTCLOUD_PASSWORD = process.env.NEXTCLOUD_PASSWORD || '';
const NEXTCLOUD_WEBDAV_BASE = `${NEXTCLOUD_URL}/remote.php/dav/files/${NEXTCLOUD_USER}`;

// Helper: derive default output path from input path
function defaultOutputPath(filePath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return path.join(dir, `${base}_processed${ext}`);
}

// Why: Centralizes word counting to avoid repeated inline logic across OCR tools.
// What: Splits text on whitespace and counts non-empty tokens.
// Test: Assert countWords("hello world") === 2, countWords("") === 0, countWords(null) === 0.
function countWords(text) {
  if (!text || typeof text !== "string") return 0;
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

// Why: Provides a local Tesseract fallback when the polycr service is unavailable.
// What: Runs tesseract twice (text + TSV for confidence), returns text, confidence, word_count, empty.
// Test: Call with a known image, assert text is non-empty and confidence is a number between 0 and 1.
async function runLocalTesseract(filePath) {
  const [textResult, tsvResult] = await Promise.all([
    execFileAsync("tesseract", [filePath, "stdout", "-l", "eng"]),
    execFileAsync("tesseract", [filePath, "stdout", "-l", "eng", "tsv"]),
  ]);
  const text = textResult.stdout;
  const lines = tsvResult.stdout.split("\n").slice(1);
  const confs = lines
    .map((l) => {
      const cols = l.split("\t");
      const level = parseInt(cols[0], 10);
      const conf = parseFloat(cols[10]);
      return level === 5 && conf >= 0 ? conf : null;
    })
    .filter((c) => c !== null);
  const confidence =
    confs.length > 0
      ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) / 100
      : null;
  const wc = countWords(text);
  return { text, confidence, word_count: wc, empty: wc === 0 };
}

// Why: Sends an image to the polycr multi-engine OCR service with a timeout guard.
// What: POSTs multipart/form-data to POLYCR_URL/ocr/raw with a 30s AbortController timeout.
// Test: Mock fetch to return a valid engine response; assert result is non-null and fallback_reason is null.
async function callPolycr(filePath) {
  const fileBytes = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase() || "jpg";
  const mimeMap = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    tiff: "image/tiff",
    bmp: "image/bmp",
  };
  const mime = mimeMap[ext] || "application/octet-stream";
  const blob = new Blob([fileBytes], { type: mime });
  const form = new FormData();
  form.append("file", blob, path.basename(filePath));
  const ac = new AbortController();
  // 30s timeout
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const resp = await fetch(`${POLYCR_URL}/ocr/raw`, {
      method: "POST",
      body: form,
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!resp.ok)
      return { result: null, fallback_reason: `polycr HTTP ${resp.status}` };
    const data = await resp.json();
    return { result: data, fallback_reason: null };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === "AbortError";
    return {
      result: null,
      fallback_reason: isTimeout
        ? "polycr timeout (30s)"
        : `polycr unreachable: ${err.message}`,
    };
  }
}

// Why: Selects the best engine result from polycr's multi-engine response to maximize text quality.
// What: Iterates engines, scores by word count (primary) + confidence (tiebreak), returns best.
// Test: Pass a data object with two engines where one has more words; assert the higher-word engine is returned.
function pickBestPolycr(data) {
  // polycr returns { results: [{engine, text, confidence, error}] }
  const results = data.results || [];
  let best = null;
  let bestScore = -1;
  for (const result of results) {
    if (!result || typeof result.text !== "string" || result.error) continue;
    const wc = countWords(result.text);
    // polycr confidence is 0–100 integer percent; normalize to 0–1
    const rawConf = typeof result.confidence === "number" ? result.confidence : 0;
    const conf = rawConf / 100;
    const score = wc * 1000 + conf;
    if (score > bestScore) {
      bestScore = score;
      best = {
        engine_used: result.engine,
        text: result.text,
        confidence: conf,
      };
    }
  }
  return best;
}

// Why: Provides transparent OCR with automatic fallback so callers don't need to manage service availability.
// What: Tries polycr first; falls back to local Tesseract if polycr is unreachable or returns no results.
// Test: Mock callPolycr to return null result; assert engine_used is 'tesseract-local' and fallback_reason is set.
async function ocrWithFallback(filePath) {
  const { result, fallback_reason } = await callPolycr(filePath);
  if (result) {
    const best = pickBestPolycr(result);
    if (best) {
      const wc = countWords(best.text);
      return {
        text: best.text,
        engine_used: best.engine_used,
        confidence: best.confidence,
        word_count: wc,
        empty: wc === 0,
        fallback_reason: undefined,
      };
    }
  }
  const local = await runLocalTesseract(filePath);
  return {
    text: local.text,
    engine_used: "tesseract-local",
    confidence: local.confidence,
    word_count: local.word_count,
    empty: local.empty,
    fallback_reason: fallback_reason || "polycr returned no engine results",
  };
}

// Keyword signal map for document classification heuristics.
const EVENT_SIGNALS = {
  invite: ["invite", "invited", "invitation"],
  rsvp: ["rsvp", "r.s.v.p", "kindly respond", "please respond", "regrets only"],
  birthday: ["birthday", "bday", "turning", "years old", "happy birthday"],
  party: [
    "party",
    "celebration",
    "celebrate",
    "soiree",
    "gathering",
    "get-together",
  ],
  wedding: [
    "wedding",
    "nuptials",
    "reception",
    "ceremony",
    "bridal",
    "rehearsal dinner",
  ],
  baby_shower: ["baby shower", "baby sprinkle", "gender reveal", "expecting"],
  graduation: ["graduation", "commencement", "graduate", "diploma"],
  holiday: [
    "holiday",
    "christmas",
    "hanukkah",
    "halloween",
    "thanksgiving",
    "new year",
  ],
  fundraiser: ["fundraiser", "fundraising", "donation", "gala", "benefit"],
  receipt: [
    "receipt",
    "total",
    "subtotal",
    "tax",
    "amount due",
    "paid",
    "invoice",
  ],
};

// Why: Provides lightweight document type detection without an ML model dependency.
// What: Scans lowercase text for keyword signals, returns likely_document_type and all matched signals.
// Test: Pass text containing "birthday" and "rsvp"; assert likely_document_type is "birthday" (first match).
function classifyDocument(text) {
  const lower = text.toLowerCase();
  const signals = [];
  for (const [type, keywords] of Object.entries(EVENT_SIGNALS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        signals.push({ type, keyword: kw });
        break;
      }
    }
  }
  const likely = signals.length > 0 ? signals[0].type : "unknown";
  return { likely_document_type: likely, document_signals: signals };
}

// --- scan_and_file helpers ---

// Why: Maps profile names to scanimage parameters so the atomic pipeline tool
//      doesn't need a large switch statement at call-site.
// What: Returns { mode, source, format } for a given profile string.
// Test: Assert PROFILE_PARAMS['doc-bw'].mode === 'Gray' and PROFILE_PARAMS['photo'].mode === 'Color'.
const PROFILE_PARAMS = {
  'doc-bw':     { mode: 'Gray',  source: 'Flatbed', format: 'jpeg' },
  'doc-bw-adf': { mode: 'Gray',  source: 'ADF',     format: 'jpeg' },
  'doc-color':  { mode: 'Color', source: 'Flatbed', format: 'jpeg' },
  'receipt':    { mode: 'Gray',  source: 'Flatbed', format: 'jpeg' },
  'id-card':    { mode: 'Color', source: 'Flatbed', format: 'jpeg' },
  'photo':      { mode: 'Color', source: 'Flatbed', format: 'jpeg' },
  'event':      { mode: 'Color', source: 'Flatbed', format: 'jpeg' },
};

// Why: Centralizes filing classification so the atomic pipeline tool routes each
//      document to the correct Nextcloud folder without caller logic.
// What: Scores OCR text and profile/description against keyword patterns; returns
//       { type, path } where path is the Nextcloud subdirectory (or null for event).
// Test: Call with profile='receipt', assert path === '/Personal/Financial/Receipts/'.
//       Call with text containing "prescription", assert type === 'medical'.
function classifyDocumentForFiling(text, profile, description) {
  const lower = (text + ' ' + (description || '')).toLowerCase();

  if (profile === 'receipt')  return { type: 'receipt',       path: '/Personal/Financial/Receipts/' };
  if (profile === 'photo')    return { type: 'photo',         path: '/Media/Photos/' };
  if (profile === 'event')    return { type: 'event',         path: null };
  if (profile === 'id-card') {
    if (lower.match(/insurance|coverage|member/)) return { type: 'insurance-card', path: '/Personal/Insurance/' };
    if (lower.match(/latvia|latvian/))            return { type: 'latvian-id',     path: '/Personal/Identity/Latvian-Citizenship/' };
    return { type: 'id', path: '/Personal/Identity/' };
  }

  // Load routing rules config — allows address/property-based routing without code changes
  let routingRules = { properties: [], custom_rules: [] };
  try {
    const rulesPath = path.join(os.homedir(), '.ocr-mcp', 'routing-rules.json');
    if (fs.existsSync(rulesPath)) {
      routingRules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    }
  } catch (_) {}

  // Check property-based routing first (most specific — beats all generic keyword checks)
  for (const prop of (routingRules.properties || [])) {
    const keywords = prop.keywords || [prop.address];
    if (keywords.some(kw => lower.includes(kw.toLowerCase()))) {
      return { type: 'housing', path: prop.path };
    }
  }

  if (lower.match(/invoice|receipt|total\s*\$|subtotal|thank you for your (purchase|order)/))
    return { type: 'receipt',   path: '/Personal/Financial/Receipts/' };
  if (lower.match(/prescription|diagnosis|patient|physician|hospital|lab result|immunization/))
    return { type: 'medical',   path: '/Personal/Health/Medical/' };
  if (lower.match(/insurance|policy number|coverage|premium|claim number/))
    return { type: 'insurance', path: '/Personal/Insurance/' };
  if (lower.match(/\b(irs|1099|w-2|w2|tax return|adjusted gross|refund)\b/))
    return { type: 'tax',       path: '/Personal/Financial/Taxes/' };
  // mortgage/loan before legal — boilerplate like "hereby" appears in mortgage letters
  if (lower.match(/rocket mortgage|mortgage statement|loan number|autopay confirmation|escrow|homeowner/))
    return { type: 'housing',   path: '/Personal/Housing/' };
  if (lower.match(/mortgage|loan statement|student loan/))
    return { type: 'financial', path: '/Personal/Financial/' };
  if (lower.match(/attorney|court|legal|plaintiff|defendant|judgment|hereby/))
    return { type: 'legal',     path: '/Personal/Legal/' };
  if (lower.match(/lease|landlord|tenant|rental agreement|property/))
    return { type: 'housing',   path: '/Personal/Housing/' };
  if (lower.match(/vehicle|registration|title|dmv|vin\b/))
    return { type: 'auto',      path: '/Personal/Auto/' };
  if (lower.match(/theodore|teddy|daycare|preschool/))
    return { type: 'theodore',  path: '/Personal/Theodore/' };

  return { type: 'document', path: '/Inbox/' };
}

// Why: Produces consistent, date-prefixed filenames from OCR text so documents are
//      sortable by date without manual renaming.
// What: Extracts first recognizable date from text (ISO, US, or long-form month);
//       falls back to today. Appends a sanitized slug derived from a title-like line
//       near the top of the document, or from description/classification as fallback.
// Test: Call with text="SUMMER ENRICHMENT PROGRAM\nJune 1, 2026" ext="pdf";
//       assert result starts with "2026-06-01_summer-enrichment-program".
function generateFilename(text, classification, description, ext) {
  const months = {
    january:'01', february:'02', march:'03',    april:'04',
    may:'05',     june:'06',     july:'07',      august:'08',
    september:'09', october:'10', november:'11', december:'12',
  };

  let dateStr = null;
  const m1 = text.match(/\b(\d{4})[\/\-](\d{2})[\/\-](\d{2})\b/);
  const m2 = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
  const m3 = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i);

  if (m1)      dateStr = `${m1[1]}-${m1[2].padStart(2,'0')}-${m1[3].padStart(2,'0')}`;
  else if (m2) dateStr = `${m2[3]}-${m2[1].padStart(2,'0')}-${m2[2].padStart(2,'0')}`;
  else if (m3) dateStr = `${m3[3]}-${months[m3[1].toLowerCase()]}-${m3[2].padStart(2,'0')}`;
  else         dateStr = new Date().toISOString().split('T')[0];

  let slug;
  if (description) {
    slug = description;
  } else {
    slug = extractTitleSlug(text) || classification.type;
  }
  slug = slug.toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 40);

  return `${dateStr}_${slug}.${ext}`;
}

// Why: Centralises title-extraction heuristics so generateFilename stays readable.
// What: Scans the first 15 lines of OCR text for a title-like line using three
//       ranked heuristics: (1) all-caps 2-6 word line in first 15 lines,
//       (2) title-case or mostly-alpha line with 2-8 words in first 10 lines,
//       (3) fallback to first 5 non-stop-word tokens from the full text.
// Test: Pass "INVOICE\nDate: 2026-01-01" → expect "INVOICE".
//       Pass "My Great Report\npage 1" → expect "My Great Report".
//       Pass "99-AB-4422\nJohn Smith\n123 Main St" → expect "john-smith" (token fallback).
function extractTitleSlug(text) {
  const stopWords = new Set(['the','a','an','of','and','or','in','to','for','is','are','was',
    'were','with','from','by','at','on','this','that','these','those','it','its','be','been',
    'has','have','had','not','but','as','if','so','do','did','will','would','could','should']);

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

  // Returns true when a line looks like noise rather than a document title.
  // Rejects lines that start with digits, contain @ or http, look like phone
  // numbers / form codes, are predominantly non-alpha characters, follow a
  // "Label: value" pattern, or consist mostly of digit-bearing tokens.
  function isNoiseLine(line) {
    if (/^[\d]/.test(line))          return true; // starts with digit
    if (/@|https?:\/\//i.test(line)) return true; // email / URL
    if (/^\d[\d\s\-().]{6,}$/.test(line)) return true; // phone-like
    // "Key: value" label lines (colon after 1-3 words) — not a document title.
    if (/^[A-Za-z][A-Za-z\s]{0,20}:/.test(line)) return true;
    // Require at least 60 % of word characters to be alphabetic.
    const wordChars = line.replace(/[^a-zA-Z0-9]/g, '');
    if (wordChars.length === 0) return true;
    const alphaRatio = (line.replace(/[^a-zA-Z]/g, '').length) / wordChars.length;
    if (alphaRatio < 0.6) return true;
    // Reject lines where the majority of tokens contain a digit (e.g. "page 1 of 3").
    const tokens = line.split(/\s+/).filter(t => t.length > 0);
    const digitTokens = tokens.filter(t => /\d/.test(t)).length;
    if (tokens.length > 0 && digitTokens / tokens.length > 0.4) return true;
    return false;
  }

  function wordCount(line) {
    return line.split(/\s+/).filter(w => w.length > 0).length;
  }

  // Returns true when the majority of alphabetic words in a line are stop words,
  // indicating navigational/boilerplate text rather than a document title.
  function isStopWordHeavy(line) {
    const words = line.split(/\s+/).map(w => w.toLowerCase().replace(/[^a-z]/g, '')).filter(w => w.length > 0);
    if (words.length === 0) return true;
    const stopCount = words.filter(w => stopWords.has(w)).length;
    return stopCount / words.length > 0.5;
  }

  // Heuristic 1: ALL-CAPS line (1-6 words) in first 15 lines.
  for (const line of lines.slice(0, 15)) {
    const wc = wordCount(line);
    if (wc >= 1 && wc <= 6 && line === line.toUpperCase() && /[A-Z]/.test(line) && !isNoiseLine(line) && !isStopWordHeavy(line)) {
      return line;
    }
  }

  // Heuristic 2: Title-case or mostly-alpha line (2-8 words) in first 10 lines.
  for (const line of lines.slice(0, 10)) {
    const wc = wordCount(line);
    if (wc >= 2 && wc <= 8 && line.length > 3 && !isNoiseLine(line) && !isStopWordHeavy(line)) {
      return line;
    }
  }

  // Heuristic 3: Fallback — first 5 non-stop-word tokens from the full text.
  const tokens = text.split(/\s+/)
    .map(t => t.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(t => t.length > 2 && !stopWords.has(t));
  return tokens.slice(0, 5).join(' ') || '';
}

// Why: Sends a JPEG to the ocrmypdf service and writes the resulting PDF to outPath.
//      Extracted so both the Flatbed path and the ADF single-page merge path share
//      identical PDF creation logic without duplication.
// What: POSTs to the polycr ocrmypdf service first (port 8001 — rotate-pages, deskew,
//       and image-dpi 300 are applied server-side). Falls back to the local ocrmypdf
//       CLI, then bare tesseract as last resort. Throws if all three attempts fail.
//       A PDF magic-byte guard (%PDF-) validates polycr responses, since the service
//       can return HTTP 200 with a JSON error body on certain inputs.
// Test: Mock fetch to return a valid PDF buffer; assert method === "polycr".
//       Mock fetch to throw; mock CLI to succeed; assert method === "ocrmypdf-local".
//       Mock all three to fail; assert the function throws.
async function createSearchablePdfFromJpeg(jpegPath, outPath) {
  // Attempt 1: remote polycr ocrmypdf service at port 8001
  // rotate-pages, deskew, and image-dpi 300 are applied server-side
  try {
    const fileBytes = fs.readFileSync(jpegPath);
    const blob = new Blob([fileBytes], { type: 'image/jpeg' });
    const form = new FormData();
    form.append('file', blob, 'scan.jpg');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);
    let pdfResp;
    try {
      pdfResp = await fetch(`${POLYCR_PDF_URL}/pdf`, {
        method: 'POST',
        body: form,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!pdfResp.ok) {
      throw new Error(`polycr service HTTP ${pdfResp.status}`);
    }
    const pdfBuf = Buffer.from(await pdfResp.arrayBuffer());
    // Validate the response is actually a PDF — polycr returns HTTP 200 with a JSON
    // error body when it rejects the image (e.g. unrecognised DPI), which would produce
    // a file with no text layer.
    if (pdfBuf.length < 5 || pdfBuf.slice(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error(`polycr service returned non-PDF response (${pdfBuf.length} bytes)`);
    }
    fs.writeFileSync(outPath, pdfBuf);
    return { path: outPath, method: 'polycr' };
  } catch (remoteErr) {
    // Attempt 2: local ocrmypdf CLI
    try {
      await execFileAsync('ocrmypdf', ['--rotate-pages', '--deskew', '--optimize', '1', '--image-dpi', '300', jpegPath, outPath]);
      return { path: outPath, method: 'ocrmypdf-local' };
    } catch (cliErr) {
      // Attempt 3: bare tesseract pdf mode as last resort
      try {
        const outStem = outPath.replace(/\.pdf$/, '');
        await execFileAsync('tesseract', [jpegPath, outStem, 'pdf']);
        return { path: outPath, method: 'tesseract-local' };
      } catch (tesseractErr) {
        throw new Error(
          `PDF creation failed — polycr service: ${remoteErr.message}; ` +
          `ocrmypdf CLI: ${cliErr.message}; ` +
          `tesseract: ${tesseractErr.message}`
        );
      }
    }
  }
}

// Why: Encapsulates the WebDAV PUT flow so the atomic pipeline handler stays readable.
// What: Ensures the target directory exists via MKCOL (ignores 405 = already exists),
//       then uploads localPath as filename into nextcloudPath. Returns the final URL.
// Test: Mock fetch; assert MKCOL is called before PUT and PUT uses Basic auth header.
async function nextcloudUpload(localPath, nextcloudPath, filename) {
  const fileBuffer = fs.readFileSync(localPath);
  const url = `${NEXTCLOUD_WEBDAV_BASE}${nextcloudPath}${encodeURIComponent(filename)}`;
  const auth = 'Basic ' + Buffer.from(`${NEXTCLOUD_USER}:${NEXTCLOUD_PASSWORD}`).toString('base64');

  // MKCOL is safe to call even when directory already exists (server returns 405).
  await fetch(`${NEXTCLOUD_WEBDAV_BASE}${nextcloudPath}`, {
    method: 'MKCOL',
    headers: { Authorization: auth },
  }).catch(() => {});

  const contentType = localPath.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: auth, 'Content-Type': contentType },
    body: fileBuffer,
  });

  if (!resp.ok) throw new Error(`Nextcloud upload failed: HTTP ${resp.status}`);
  return url;
}

// --- end scan_and_file helpers ---

const server = new Server(
  { name: "ocr-mcp", version: "1.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ocr_image_local",
      description:
        "Extract text from a local image file using Tesseract OCR. Returns JSON with text, word_count, and empty flag. Optionally preprocesses the image for better results.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the local image file",
          },
          preprocess: {
            type: "boolean",
            description:
              "If true, runs enhance_image_for_ocr first (grayscale + normalize + sharpen) before OCR. Default: false.",
          },
        },
        required: ["file_path"],
      },
    },
    {
      name: "ocr_image_polycr",
      description:
        "Extract text from a local image using the polycr multi-engine OCR service with automatic fallback to local Tesseract. Returns JSON with text, engine_used, confidence, word_count, empty, and optional fallback_reason.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the local image file",
          },
        },
        required: ["file_path"],
      },
    },
    {
      name: "extract_event_details",
      description:
        "OCR an image and classify the document type using keyword heuristics. Auto-orients the image first. Returns raw_text, engine_used, confidence, word_count, likely_document_type, and document_signals.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the local image file",
          },
        },
        required: ["file_path"],
      },
    },
    {
      name: "ocr_image_from_base64",
      description:
        "Decode a base64-encoded image and extract text using polycr with Tesseract fallback. Returns JSON with text, engine_used, confidence, word_count, empty, and optional fallback_reason.",
      inputSchema: {
        type: "object",
        properties: {
          base64_data: {
            type: "string",
            description: "Base64-encoded image data",
          },
          mime_type: {
            type: "string",
            description:
              "MIME type of the image (image/jpeg, image/png, image/gif, image/webp, image/tiff, image/bmp)",
          },
        },
        required: ["base64_data", "mime_type"],
      },
    },
    {
      name: "ocr_image_from_url",
      description:
        "Download an image from a URL and extract text using polycr with Tesseract fallback. Enforces a 30s download timeout and a 20MB size limit. Returns JSON with text, engine_used, confidence, word_count, empty, and optional fallback_reason.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL of the image to download and OCR",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "rotate_image",
      description:
        "Rotate an image by a specified number of degrees using ImageMagick.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the input image file",
          },
          degrees: {
            type: "number",
            description:
              "Degrees to rotate (e.g. 90, 180, 270, or any value). Positive = clockwise.",
          },
          output_path: {
            type: "string",
            description:
              "Optional output path. If omitted, overwrites the input file in place.",
          },
        },
        required: ["file_path", "degrees"],
      },
    },
    {
      name: "auto_orient_image",
      description:
        "Fix image orientation based on EXIF metadata using ImageMagick -auto-orient.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the input image file",
          },
          output_path: {
            type: "string",
            description:
              "Optional output path. Defaults to <basename>_processed.<ext> in the same directory.",
          },
        },
        required: ["file_path"],
      },
    },
    {
      name: "enhance_image_for_ocr",
      description:
        "Preprocess an image for better Tesseract OCR results: auto-orient, convert to grayscale, normalize contrast, and sharpen.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the input image file",
          },
          output_path: {
            type: "string",
            description:
              "Optional output path. Defaults to <basename>_processed.<ext> in the same directory.",
          },
        },
        required: ["file_path"],
      },
    },
    {
      name: "scan_document",
      description:
        "Scan a document using scanimage. Defaults to hp-officejet-5740 (escl:http://192.168.1.183:8080). Returns success, path, resolution, mode, source, and scanner on success.",
      inputSchema: {
        type: "object",
        properties: {
          output_path: {
            type: "string",
            description: "Output file path (e.g. /tmp/scan.jpg)",
          },
          resolution: {
            type: "number",
            description: "DPI resolution (default 300)",
          },
          mode: {
            type: "string",
            enum: ["Color", "Gray"],
            description: "Color or grayscale (default Color)",
          },
          source: {
            type: "string",
            enum: ["Flatbed", "ADF"],
            description: "Flatbed platen or ADF feeder (default Flatbed)",
          },
          scanner: {
            type: "string",
            enum: ["hp-officejet-5740", "canon-mf741c"],
            description: "Which scanner to use (default: hp-officejet-5740)",
          },
        },
        required: ["output_path"],
      },
    },
    {
      name: "create_searchable_pdf",
      description:
        "Convert an image (or existing PDF) into a searchable PDF with an embedded text layer by sending it to the ocrmypdf service on the polycr host (port 8001). Falls back to local `tesseract ... pdf` if the service is unreachable. Returns the output PDF path and file size.",
      inputSchema: {
        type: "object",
        properties: {
          image_path: {
            type: "string",
            description: "Absolute path to the input image or PDF file",
          },
          deskew: {
            type: "boolean",
            description: "Deskew the input before OCR (default true)",
          },
          optimize: {
            type: "number",
            description: "PDF optimization level 0–3 (default 1)",
          },
        },
        required: ["image_path"],
      },
    },
    {
      name: "scan_and_file",
      description:
        "Atomic pipeline: scan document → OCR → create searchable PDF → upload to Nextcloud. Executes the full pipeline in one call. Returns what was scanned, filename used, and where it was filed.",
      inputSchema: {
        type: "object",
        properties: {
          profile: {
            type: "string",
            enum: ["doc-bw", "doc-bw-adf", "doc-color", "receipt", "id-card", "photo", "event"],
            description: "Scanning profile to use",
          },
          description: {
            type: "string",
            description: "Optional hint for filename/classification (e.g. 'verizon bill', 'theodore immunization')",
          },
          nextcloud_path: {
            type: "string",
            description: "Override auto-classified Nextcloud path (e.g. /Personal/Legal/). Include trailing slash.",
          },
          filename: {
            type: "string",
            description: "Override auto-generated filename (e.g. 2026-04-13_verizon-bill.pdf)",
          },
          separate_pages: {
            type: "boolean",
            description: "ADF only: file each page as a separate document instead of merging into one PDF (default false)",
          },
          scanner: {
            type: "string",
            enum: ["hp-officejet-5740", "canon-mf741c"],
            description: "Which scanner to use (default: hp-officejet-5740)",
          },
        },
        required: ["profile"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "ocr_image_local") {
    const { file_path, preprocess = false } = args;

    if (!file_path || typeof file_path !== "string") {
      throw new Error("file_path must be a non-empty string");
    }

    let targetPath = file_path;
    let tempFile = null;

    if (preprocess) {
      const ext = path.extname(file_path) || ".jpg";
      tempFile = path.join(os.tmpdir(), `ocr_preprocess_${Date.now()}${ext}`);
      try {
        execSync(
          `convert -auto-orient -colorspace gray -normalize -sharpen 0x1 ${JSON.stringify(file_path)} ${JSON.stringify(tempFile)}`
        );
      } catch (e) {
        throw new Error(`ImageMagick failed: ${e.message}`);
      }
      targetPath = tempFile;
    }

    try {
      const { stdout } = await execFileAsync("tesseract", [
        targetPath,
        "stdout",
        "-l",
        "eng",
      ]);
      const wc = countWords(stdout);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ text: stdout, word_count: wc, empty: wc === 0 }),
          },
        ],
      };
    } finally {
      if (tempFile && fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  }

  if (name === "ocr_image_polycr") {
    const { file_path } = args;

    if (!file_path || typeof file_path !== "string") {
      throw new Error("file_path must be a non-empty string");
    }
    if (!fs.existsSync(file_path)) {
      throw new Error(`File not found: ${file_path}`);
    }

    const result = await ocrWithFallback(file_path);
    const output = {
      text: result.text,
      engine_used: result.engine_used,
      confidence: result.confidence,
      word_count: result.word_count,
      empty: result.empty,
    };
    if (result.fallback_reason) {
      output.fallback_reason = result.fallback_reason;
    }
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
    };
  }

  if (name === "extract_event_details") {
    const { file_path } = args;

    if (!file_path || typeof file_path !== "string") {
      throw new Error("file_path must be a non-empty string");
    }
    if (!fs.existsSync(file_path)) {
      throw new Error(`File not found: ${file_path}`);
    }

    const ext = path.extname(file_path) || ".jpg";
    const tempFile = path.join(
      os.tmpdir(),
      `event_orient_${Date.now()}${ext}`
    );

    try {
      try {
        execSync(
          `convert -auto-orient ${JSON.stringify(file_path)} ${JSON.stringify(tempFile)}`
        );
      } catch (e) {
        throw new Error(`ImageMagick failed: ${e.message}`);
      }
      const ocrResult = await ocrWithFallback(tempFile);
      const { likely_document_type, document_signals } = classifyDocument(
        ocrResult.text
      );
      const output = {
        raw_text: ocrResult.text,
        engine_used: ocrResult.engine_used,
        confidence: ocrResult.confidence,
        word_count: ocrResult.word_count,
        likely_document_type,
        document_signals,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
      };
    } finally {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  }

  if (name === "ocr_image_from_base64") {
    const { base64_data, mime_type } = args;

    const allowedMimes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/tiff",
      "image/bmp",
    ];
    if (!allowedMimes.includes(mime_type)) {
      throw new Error(
        `Invalid mime_type. Must be one of: ${allowedMimes.join(", ")}`
      );
    }

    const extMap = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/tiff": ".tiff",
      "image/bmp": ".bmp",
    };
    const ext = extMap[mime_type];
    const tempFile = path.join(os.tmpdir(), `ocr_b64_${Date.now()}${ext}`);

    try {
      fs.writeFileSync(tempFile, Buffer.from(base64_data, "base64"));
      const result = await ocrWithFallback(tempFile);
      const output = {
        text: result.text,
        engine_used: result.engine_used,
        confidence: result.confidence,
        word_count: result.word_count,
        empty: result.empty,
      };
      if (result.fallback_reason) {
        output.fallback_reason = result.fallback_reason;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
      };
    } finally {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  }

  if (name === "ocr_image_from_url") {
    const { url } = args;

    if (!url || typeof url !== "string") {
      throw new Error("url must be a non-empty string");
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30000);
    let tempFile = null;

    try {
      const resp = await fetch(url, { signal: ac.signal });
      clearTimeout(timer);

      if (!resp.ok) {
        throw new Error(`Failed to download image: HTTP ${resp.status}`);
      }

      const contentType = resp.headers.get("content-type") || "";
      if (!contentType.startsWith("image/")) {
        throw new Error(
          `URL does not point to an image (Content-Type: ${contentType})`
        );
      }

      const extFromMime = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/tiff": ".tiff",
        "image/bmp": ".bmp",
      };
      const mimeBase = contentType.split(";")[0].trim();
      const ext = extFromMime[mimeBase] || ".jpg";
      tempFile = path.join(os.tmpdir(), `ocr_url_${Date.now()}${ext}`);

      const MAX_BYTES = 20 * 1024 * 1024;
      const chunks = [];
      let totalBytes = 0;

      for await (const chunk of resp.body) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BYTES) {
          throw new Error("Image exceeds 20MB size limit");
        }
        chunks.push(chunk);
      }

      fs.writeFileSync(tempFile, Buffer.concat(chunks));

      const result = await ocrWithFallback(tempFile);
      const output = {
        text: result.text,
        engine_used: result.engine_used,
        confidence: result.confidence,
        word_count: result.word_count,
        empty: result.empty,
      };
      if (result.fallback_reason) {
        output.fallback_reason = result.fallback_reason;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
      };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    } finally {
      if (tempFile && fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  }

  if (name === "rotate_image") {
    const { file_path, degrees, output_path } = args;

    if (!file_path || typeof file_path !== "string") {
      throw new Error("file_path must be a non-empty string");
    }
    if (typeof degrees !== "number") {
      throw new Error("degrees must be a number");
    }

    let outPath;
    let useTmp = false;
    if (output_path) {
      outPath = output_path;
    } else {
      outPath = file_path;
      useTmp = true;
    }

    if (useTmp) {
      const ext = path.extname(file_path) || ".jpg";
      const tmp = path.join(os.tmpdir(), `rotate_tmp_${Date.now()}${ext}`);
      try {
        execSync(
          `convert -rotate ${degrees} ${JSON.stringify(file_path)} ${JSON.stringify(tmp)}`
        );
      } catch (e) {
        throw new Error(`ImageMagick failed: ${e.message}`);
      }
      fs.renameSync(tmp, file_path);
      outPath = file_path;
    } else {
      try {
        execSync(
          `convert -rotate ${degrees} ${JSON.stringify(file_path)} ${JSON.stringify(outPath)}`
        );
      } catch (e) {
        throw new Error(`ImageMagick failed: ${e.message}`);
      }
    }

    return {
      content: [{ type: "text", text: outPath }],
    };
  }

  if (name === "auto_orient_image") {
    const { file_path, output_path } = args;

    if (!file_path || typeof file_path !== "string") {
      throw new Error("file_path must be a non-empty string");
    }

    const outPath = output_path || defaultOutputPath(file_path);
    try {
      execSync(
        `convert -auto-orient ${JSON.stringify(file_path)} ${JSON.stringify(outPath)}`
      );
    } catch (e) {
      throw new Error(`ImageMagick failed: ${e.message}`);
    }

    return {
      content: [{ type: "text", text: outPath }],
    };
  }

  if (name === "enhance_image_for_ocr") {
    const { file_path, output_path } = args;

    if (!file_path || typeof file_path !== "string") {
      throw new Error("file_path must be a non-empty string");
    }

    const outPath = output_path || defaultOutputPath(file_path);
    try {
      execSync(
        `convert -auto-orient -colorspace gray -normalize -sharpen 0x1 ${JSON.stringify(file_path)} ${JSON.stringify(outPath)}`
      );
    } catch (e) {
      throw new Error(`ImageMagick failed: ${e.message}`);
    }

    return {
      content: [{ type: "text", text: outPath }],
    };
  }

  if (name === "scan_document") {
    const {
      output_path,
      resolution = 300,
      mode = "Color",
      source = "Flatbed",
      scanner = 'hp-officejet-5740',
    } = args;
    const deviceName = SCANNERS[scanner] || DEFAULT_SCANNER;

    if (!output_path || typeof output_path !== "string") {
      throw new Error("output_path must be a non-empty string");
    }

    // Infer scanimage format from file extension
    const ext = path.extname(output_path).toLowerCase();
    let format;
    if (ext === ".jpg" || ext === ".jpeg") {
      format = "jpeg";
    } else if (ext === ".pdf") {
      format = "pdf";
    } else if (ext === ".png") {
      format = "png";
    } else {
      format = "jpeg";
    }

    try {
      execSync(
        `scanimage --device-name=${JSON.stringify(deviceName)} --format=${format} --output-file=${JSON.stringify(output_path)} --resolution=${resolution} --mode=${JSON.stringify(mode)} --source=${JSON.stringify(source)}`
      );
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: e.message }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            path: output_path,
            resolution,
            mode,
            source,
            scanner,
          }),
        },
      ],
    };
  }

  if (name === "create_searchable_pdf") {
    // Why: Produces an archival searchable PDF by delegating to the ocrmypdf service
    //      running alongside polycr, with a local Tesseract fallback for resilience.
    // What: POSTs the file to POLYCR_PDF_URL/pdf, saves the returned PDF next to the
    //       input file (same directory, .pdf extension), and returns path + size_bytes.
    //       Falls back to `tesseract <input> <stem> pdf` if the service is unreachable.
    // Test: Mock fetch to return a PDF buffer; assert pdf_path ends in .pdf and size_bytes > 0.
    //       Mock fetch to throw; assert fallback_reason is set and pdf_path still exists.
    const { image_path, deskew = true, optimize = 1 } = args;

    if (!image_path || typeof image_path !== "string") {
      throw new Error("image_path must be a non-empty string");
    }
    if (!fs.existsSync(image_path)) {
      throw new Error(`File not found: ${image_path}`);
    }

    const dir = path.dirname(image_path);
    const stem = path.basename(image_path, path.extname(image_path));
    const pdfPath = path.join(dir, `${stem}.pdf`);

    // Attempt remote ocrmypdf service first
    try {
      const fileBytes = fs.readFileSync(image_path);
      const ext = path.extname(image_path).slice(1).toLowerCase() || "jpg";
      const mimeMap = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
        gif: "image/gif", webp: "image/webp", tiff: "image/tiff",
        bmp: "image/bmp", pdf: "application/pdf",
      };
      const mime = mimeMap[ext] || "application/octet-stream";
      const blob = new Blob([fileBytes], { type: mime });
      const form = new FormData();
      form.append("file", blob, path.basename(image_path));

      const params = new URLSearchParams({
        deskew: String(deskew),
        optimize: String(optimize),
      });

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60000);

      let resp;
      try {
        resp = await fetch(`${POLYCR_PDF_URL}/pdf?${params}`, {
          method: "POST",
          body: form,
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        throw new Error(`ocrmypdf service HTTP ${resp.status}: ${errBody}`);
      }

      const pdfBuffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(pdfPath, pdfBuffer);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ pdf_path: pdfPath, size_bytes: pdfBuffer.length }),
          },
        ],
      };
    } catch (remoteErr) {
      // Fallback: run tesseract locally to produce a PDF
      const fallbackReason = remoteErr.name === "AbortError"
        ? "ocrmypdf service timeout (60s)"
        : `ocrmypdf service unreachable: ${remoteErr.message}`;

      try {
        const outStem = path.join(dir, stem);
        await execFileAsync("tesseract", [image_path, outStem, "pdf"]);
        const size = fs.statSync(pdfPath).size;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ pdf_path: pdfPath, size_bytes: size, fallback_reason: fallbackReason }),
            },
          ],
        };
      } catch (localErr) {
        throw new Error(
          `ocrmypdf service failed (${fallbackReason}) and local tesseract fallback also failed: ${localErr.message}`
        );
      }
    }
  }

  if (name === "scan_and_file") {
    // Why: Executes the full scan→OCR→PDF→upload pipeline atomically so a context
    //      bootstrap reset cannot interrupt it between steps.
    // What: Scans via scanimage, OCRs via polycr (Tesseract fallback), creates a
    //       searchable PDF via ocrmypdf service (Tesseract fallback), uploads to
    //       Nextcloud WebDAV, cleans up temp files, returns a summary object.
    // Test: Mock execSync for scanimage success; mock fetch for polycr and ocrmypdf;
    //       assert result.success is true, result.filed_at is non-null, and temp
    //       files are deleted by the end of the call.
    const { profile, description, nextcloud_path: ncPathOverride, filename: filenameOverride, separate_pages = false, scanner = 'hp-officejet-5740' } = args;
    const deviceName = SCANNERS[scanner] || DEFAULT_SCANNER;
    const params = PROFILE_PARAMS[profile];
    if (!params) throw new Error(`Unknown profile: ${profile}`);

    // Canon MF741C ADF only accepts Color mode (Gray returns "Invalid argument")
    let scanMode = params.mode;
    if (scanner === 'canon-mf741c' && params.source === 'ADF') {
      scanMode = 'Color';
    }

    const timestamp = Date.now();
    const isADF = params.source === 'ADF';

    // Why: Track all temp files across all pages so the finally block can clean
    //      them up regardless of success or failure on any individual page.
    const allTempFiles = [];

    // Why: Track generated base filenames to detect same-second collisions and
    //      append _p2, _p3 suffixes before the extension.
    const usedFilenames = new Set();

    /**
     * Why: Encapsulates the OCR→classify→PDF→upload pipeline for a single page
     *      so it can be called in a loop for ADF or once for Flatbed.
     * What: Given a JPEG temp path and per-page PDF temp path, runs Steps 2-5
     *       and returns the flat result object.
     * Test: Pass a known JPEG path with mocked ocrWithFallback; assert result.success.
     */
    async function processSinglePage(tmpJpeg, tmpPdf, pageLabel) {
      // Step 2: OCR (skip for photo profile)
      let ocrText = '';
      let wordCount = 0;
      let confidence = 0;

      if (profile !== 'photo') {
        const ocrResult = await ocrWithFallback(tmpJpeg);
        ocrText = ocrResult.text || '';
        wordCount = ocrResult.word_count || 0;
        confidence = ocrResult.confidence || 0;

        // Low-confidence retry with image enhancement
        if (wordCount < 10) {
          const enhanced = tmpJpeg.replace('.jpg', '_enhanced.jpg');
          allTempFiles.push(enhanced);
          try {
            execSync(`convert ${JSON.stringify(tmpJpeg)} -normalize -sharpen 0x1 -threshold 50% ${JSON.stringify(enhanced)}`, { timeout: 30000 });
            const enhancedResult = await ocrWithFallback(enhanced);
            if ((enhancedResult.word_count || 0) > wordCount) {
              ocrText = enhancedResult.text || '';
              wordCount = enhancedResult.word_count || 0;
              confidence = enhancedResult.confidence || 0;
            }
          } catch (_) {
            // enhancement failed — keep original OCR result
          }
        }
      }

      // Step 3: Classify + generate filename (deduplicate same-second collisions)
      const classification = classifyDocumentForFiling(ocrText, profile, description);
      const ext = profile === 'photo' ? 'jpg' : 'pdf';
      let baseFilename = filenameOverride || generateFilename(ocrText, classification, description || '', ext);
      if (usedFilenames.has(baseFilename)) {
        // Append _p2, _p3 … before the extension to avoid collisions
        const dotIdx = baseFilename.lastIndexOf('.');
        const stem = dotIdx >= 0 ? baseFilename.slice(0, dotIdx) : baseFilename;
        const extPart = dotIdx >= 0 ? baseFilename.slice(dotIdx) : '';
        let suffix = 2;
        let candidate = `${stem}_p${suffix}${extPart}`;
        while (usedFilenames.has(candidate)) {
          suffix += 1;
          candidate = `${stem}_p${suffix}${extPart}`;
        }
        baseFilename = candidate;
      }
      usedFilenames.add(baseFilename);
      const filename = baseFilename;
      const ncPath = ncPathOverride || classification.path;

      // Step 4: Create searchable PDF (skip for photo and event)
      let fileToUpload = tmpJpeg;
      let pdfMethod = 'jpeg-only';
      if (profile !== 'photo' && profile !== 'event') {
        const pdfResult = await createSearchablePdfFromJpeg(tmpJpeg, tmpPdf);
        fileToUpload = pdfResult.path;
        pdfMethod = pdfResult.method;
      }

      // Step 5: Upload to Nextcloud (skip for event profile)
      if (profile !== 'event' && ncPath) {
        await nextcloudUpload(fileToUpload, ncPath, filename);
      }

      // Build per-page result object
      const result = {
        success: true,
        profile,
        scanner,
        filename,
        nextcloud_path: ncPath,
        filed_at: ncPath ? `${ncPath}${filename}` : null,
        document_type: classification.type,
        pdf_method: pdfMethod,
        word_count: wordCount,
        confidence: Math.round(confidence * 100) / 100,
        ocr_preview: ocrText.slice(0, 300).trim() || null,
      };

      if (profile === 'event') {
        result.note = 'Event profile — use ocr__extract_event_details for calendar creation instead.';
        result.raw_text = ocrText;
      }

      return result;
    }

    try {
      if (isADF) {
        // Why: ADF feeder may contain multiple pages; scan one page at a time in a
        //      loop until SANE signals the feeder is empty (exit code 7 / "No documents").
        // What: By default (separate_pages=false) collects all page JPEGs, merges them
        //       into a single multi-page PDF via ImageMagick, OCRs the merged PDF once,
        //       and files as one document. When separate_pages=true, falls back to the
        //       original per-page pipeline for backward compatibility.
        // Test: Mock execSync to succeed twice then throw with "No documents"; with
        //       separate_pages=false assert result.pages===2 and result.success===true;
        //       with separate_pages=true assert results.length===2.

        // Step 1: Collect all page JPEGs from ADF
        const pageJpegs = [];
        let pageNum = 0;

        while (true) {
          pageNum += 1;
          const tmpJpeg = `/tmp/scan_${timestamp}_p${pageNum}.jpg`;
          allTempFiles.push(tmpJpeg);

          try {
            execSync(
              `scanimage --device-name=${JSON.stringify(deviceName)} --format=jpeg --output-file=${JSON.stringify(tmpJpeg)} --resolution=300 --mode=${JSON.stringify(scanMode)} --source=${JSON.stringify(params.source)}`,
              { timeout: 60000 }
            );
          } catch (scanErr) {
            // SANE exit code 7 / "No documents in feeder" / "Document feeder empty"
            // means normal end-of-feeder — not an error worth reporting.
            const msg = (scanErr.stderr || scanErr.message || '').toString();
            if (
              msg.includes('No documents') ||
              msg.includes('Document feeder empty') ||
              (scanErr.status === 7)
            ) {
              break; // feeder exhausted — stop the loop
            }
            throw scanErr; // unexpected scan error — propagate
          }

          pageJpegs.push(tmpJpeg);
        }

        if (pageJpegs.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'ADF feeder was empty — no pages scanned.' }) }],
            isError: true,
          };
        }

        if (separate_pages) {
          // Opt-in: original per-page pipeline — process each JPEG independently
          const pageResults = [];
          for (let i = 0; i < pageJpegs.length; i++) {
            const tmpJpeg = pageJpegs[i];
            const tmpPdf  = `/tmp/scan_${timestamp}_p${i + 1}.pdf`;
            allTempFiles.push(tmpPdf);
            const pageResult = await processSinglePage(tmpJpeg, tmpPdf, `p${i + 1}`);
            pageResults.push(pageResult);
          }

          // Return flat format for single page (backward compat), multi-page envelope otherwise
          const response = pageResults.length === 1
            ? pageResults[0]
            : { success: true, pages: pageResults.length, results: pageResults };

          return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
        }

        // Default: merge all pages into one PDF and file as a single document
        // Why: Multi-page ADF scans are one logical document; merging avoids N separate
        //      Nextcloud files and preserves page order for searchable PDF output.

        // Step 2: OCR page 1 only for filename/classification (title is on page 1)
        let ocrText = '';
        let wordCount = 0;
        let confidence = 0;

        if (profile !== 'photo') {
          const ocrResult = await ocrWithFallback(pageJpegs[0]);
          ocrText = ocrResult.text || '';
          wordCount = ocrResult.word_count || 0;
          confidence = ocrResult.confidence || 0;

          // Low-confidence retry with image enhancement on page 1
          if (wordCount < 10) {
            const enhanced = pageJpegs[0].replace('.jpg', '_enhanced.jpg');
            allTempFiles.push(enhanced);
            try {
              execSync(`convert ${JSON.stringify(pageJpegs[0])} -normalize -sharpen 0x1 -threshold 50% ${JSON.stringify(enhanced)}`, { timeout: 30000 });
              const enhancedResult = await ocrWithFallback(enhanced);
              if ((enhancedResult.word_count || 0) > wordCount) {
                ocrText = enhancedResult.text || '';
                wordCount = enhancedResult.word_count || 0;
                confidence = enhancedResult.confidence || 0;
              }
            } catch (_) {
              // enhancement failed — keep original OCR result
            }
          }
        }

        // Step 3: Classify + generate filename from page 1 OCR
        const classification = classifyDocumentForFiling(ocrText, profile, description);
        const ext = profile === 'photo' ? 'jpg' : 'pdf';
        const filename = filenameOverride || generateFilename(ocrText, classification, description || '', ext);
        const ncPath = ncPathOverride || classification.path;

        // Step 4: Merge all page JPEGs into one PDF via ImageMagick, then run ocrmypdf
        let fileToUpload;
        let pdfMethod = 'jpeg-only';

        if (profile === 'photo' || profile === 'event') {
          // For photo/event profiles skip PDF creation; use page 1 JPEG only
          fileToUpload = pageJpegs[0];
        } else {
          const mergedPdf = `/tmp/scan_${timestamp}_merged.pdf`;
          allTempFiles.push(mergedPdf);

          if (pageJpegs.length === 1) {
            // Single page — no ImageMagick merge needed, process JPEG directly
            const pdfResult = await createSearchablePdfFromJpeg(pageJpegs[0], mergedPdf);
            fileToUpload = pdfResult.path;
            pdfMethod = pdfResult.method;
          } else {
            // Multiple pages — merge JPEGs into a single PDF first
            execSync(
              `convert ${pageJpegs.map(p => JSON.stringify(p)).join(' ')} ${JSON.stringify(mergedPdf)}`,
              { timeout: 60000 }
            );

            // Step 5: Run ocrmypdf on the merged PDF (remote service, then local CLI fallback)
            const ocrPdf = `/tmp/scan_${timestamp}_ocr.pdf`;
            allTempFiles.push(ocrPdf);
            try {
              const fileBytes = fs.readFileSync(mergedPdf);
              const blob = new Blob([fileBytes], { type: 'application/pdf' });
              const form = new FormData();
              form.append('file', blob, 'merged.pdf');
              const pdfParams = new URLSearchParams({ deskew: 'true', optimize: '1', rotate_pages: 'true' });
              const ac = new AbortController();
              const timer = setTimeout(() => ac.abort(), 120000);
              let pdfResp;
              try {
                pdfResp = await fetch(`${POLYCR_PDF_URL}/pdf?${pdfParams}`, {
                  method: 'POST',
                  body: form,
                  signal: ac.signal,
                });
              } finally {
                clearTimeout(timer);
              }
              if (pdfResp.ok) {
                const pdfBuf = Buffer.from(await pdfResp.arrayBuffer());
                fs.writeFileSync(ocrPdf, pdfBuf);
                fileToUpload = ocrPdf;
                pdfMethod = 'polycr';
              } else {
                throw new Error(`ocrmypdf service HTTP ${pdfResp.status}`);
              }
            } catch (_remoteErr) {
              // Fallback: ocrmypdf CLI on the already-merged PDF
              try {
                await execFileAsync('ocrmypdf', ['--deskew', '--optimize', '1', mergedPdf, ocrPdf]);
                fileToUpload = ocrPdf;
                pdfMethod = 'ocrmypdf-local';
              } catch (_cliErr) {
                // Last resort: upload the raw merged PDF without a text layer
                fileToUpload = mergedPdf;
                pdfMethod = 'merged-no-ocr';
              }
            }
          }
        }

        // Step 6: Upload single PDF to Nextcloud
        if (profile !== 'event' && ncPath) {
          await nextcloudUpload(fileToUpload, ncPath, filename);
        }

        // Build flat single-result response
        const mergedResult = {
          success: true,
          profile,
          scanner,
          filename,
          nextcloud_path: ncPath,
          filed_at: ncPath ? `${ncPath}${filename}` : null,
          document_type: classification.type,
          pdf_method: pdfMethod,
          pages: pageJpegs.length,
          word_count: wordCount,
          confidence: Math.round(confidence * 100) / 100,
          ocr_preview: ocrText.slice(0, 300).trim() || null,
        };

        if (profile === 'event') {
          mergedResult.note = 'Event profile — use ocr__extract_event_details for calendar creation instead.';
          mergedResult.raw_text = ocrText;
        }

        return { content: [{ type: 'text', text: JSON.stringify(mergedResult, null, 2) }] };

      } else {
        // Non-ADF (Flatbed): original single-scan path
        const tmpJpeg = `/tmp/scan_${timestamp}.jpg`;
        const tmpPdf  = `/tmp/scan_${timestamp}.pdf`;
        allTempFiles.push(tmpJpeg, tmpPdf);

        // Step 1: Scan
        execSync(
          `scanimage --device-name=${JSON.stringify(deviceName)} --format=jpeg --output-file=${JSON.stringify(tmpJpeg)} --resolution=300 --mode=${JSON.stringify(scanMode)} --source=${JSON.stringify(params.source)}`,
          { timeout: 60000 }
        );

        const result = await processSinglePage(tmpJpeg, tmpPdf, 'p1');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }],
        isError: true,
      };
    } finally {
      // Clean up all temp files regardless of success or failure
      for (const f of allTempFiles) {
        try { execSync(`rm -f ${JSON.stringify(f)}`); } catch (_) {}
      }
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
