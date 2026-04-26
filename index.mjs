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
// Default scanner
const DEFAULT_SCANNER = SCANNERS['canon-mf741c'];

const NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'https://nextcloud.shifting-ground.link';
const NEXTCLOUD_USER = process.env.NEXTCLOUD_USER || 'your-nextcloud-user';
const NEXTCLOUD_PASSWORD = process.env.NEXTCLOUD_PASSWORD || '';
const NEXTCLOUD_WEBDAV_BASE = `${NEXTCLOUD_URL}/remote.php/dav/files/${NEXTCLOUD_USER}`;

// Direct eSCL base URL for the Canon MF741C.
// Used for multi-page ADF scanning — scanimage's per-call loop and --batch mode both
// have issues with eSCL: each new SANE session causes the Canon to feed ALL remaining
// pages but only return page 1. The eSCL HTTP API gives per-page control via
// NextDocument fetches within a single job.
const CANON_ESCL_BASE = process.env.CANON_ESCL_BASE || 'http://192.168.1.141';

// LiteLLM proxy — OpenAI-compatible endpoint on the local network.
// Used for LLM-based OCR reconciliation: all engine outputs are fed to the
// LLM and it returns the best possible merged transcription.
const LITELLM_URL = process.env.LITELLM_URL || 'http://192.168.1.19:4000/v1/chat/completions';
const LITELLM_KEY = process.env.LITELLM_KEY || 'sk-litellm-openclaw';
const LITELLM_MODEL = process.env.LITELLM_MODEL || 'auto';

// Why: Provides a promisified sleep for async retry loops and rate-limit backoff.
// What: Returns a Promise that resolves after `ms` milliseconds.
// Test: Assert `await delay(50)` completes without error and takes ~50ms.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// Why: Selects the best engine result using confidence-weighted scoring and first-line consensus.
// What: Drops results with confidence < 15 (unless only option). Scores by (word_count * 10 + confidence).
//       If 2+ engines agree on the first non-empty line, boosts those engines by 500 points so
//       consensus text wins over a high-word-count outlier.
// Test: Pass results where two engines agree first line "DECRAENES SERVICE CENTER" and third has more
//       words but disagrees — assert the consensus engine wins.
function pickBestPolycr(data) {
  const results = (data.results || []).filter(r => r && typeof r.text === 'string' && !r.error);
  if (results.length === 0) return null;

  // Normalize first non-empty line for consensus comparison
  function firstLine(text) {
    return (text.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) || '')
      .toLowerCase().replace(/\s+/g, ' ');
  }

  // Drop very low confidence results unless they're the only ones
  const confident = results.filter(r => (typeof r.confidence === 'number' ? r.confidence : 0) >= 15);
  const pool = confident.length > 0 ? confident : results;

  // Count first-line agreement
  const firstLines = pool.map(r => firstLine(r.text));
  const lineCounts = {};
  for (const l of firstLines) lineCounts[l] = (lineCounts[l] || 0) + 1;
  const consensusLine = Object.entries(lineCounts).sort((a, b) => b[1] - a[1])[0];
  const hasConsensus = consensusLine && consensusLine[1] >= 2;

  let best = null;
  let bestScore = -1;
  for (const result of pool) {
    const wc = countWords(result.text);
    const conf = typeof result.confidence === 'number' ? result.confidence : 0;
    let score = wc * 10 + conf;
    // Boost engines whose first line matches the consensus
    if (hasConsensus && firstLine(result.text) === consensusLine[0]) score += 500;
    if (score > bestScore) {
      bestScore = score;
      best = { engine_used: result.engine, text: result.text, confidence: conf / 100 };
    }
  }
  return best;
}

// Why: Feeds all OCR engine outputs to an LLM so it can reconcile disagreements,
//      correct garbled characters, and reconstruct ambiguous proper nouns (e.g.
//      "DeCraenes Service Center" from engines that disagree on capitalisation).
// What: Formats each engine's text as a numbered block, sends them to the LiteLLM
//       proxy with a reconciliation prompt, and returns the LLM's merged transcription.
//       Returns null on any error so callers can fall back gracefully.
// Test: Mock fetch to return { choices:[{message:{content:"reconciled text"}}] };
//       assert return value is "reconciled text".
//       Mock fetch to throw; assert return value is null.
async function reconcileOcrWithLLM(engineResults) {
  if (!engineResults || engineResults.length < 1) return null;

  const versionsText = engineResults
    .map((r, i) => `--- Engine ${i + 1} (${r.engine}) ---\n${r.text.trim()}`)
    .join('\n\n');

  const prompt =
    `You are a document transcription assistant. The following are ${engineResults.length} OCR readings of the same physical document page, each produced by a different OCR engine. Each version may have recognition errors: garbled characters, wrong capitalisation, missed words, or split tokens.\n\n` +
    `Your task: reconcile these into the single most accurate transcription of what the document actually says. Use all versions as evidence — prefer readings that are consistent across engines, and use context to resolve ambiguities (e.g. if two engines read "DeCraenes" and one reads "DeCraenee", the correct spelling is almost certainly "DeCraenes"). Preserve proper nouns, company names, dates, dollar amounts, and structured layout (line breaks, columns, addresses).\n\n` +
    `Output ONLY the reconciled document text. Do not add commentary, headers, labels, or explanations. Preserve the original document structure and line breaks as faithfully as possible.\n\n` +
    versionsText;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30000);
      let resp;
      try {
        resp = await fetch(LITELLM_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${LITELLM_KEY}`,
          },
          body: JSON.stringify({
            model: LITELLM_MODEL,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 4096,
            temperature: 0,
          }),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) {
        console.error(`reconcileOcrWithLLM: attempt ${attempt} failed with HTTP ${resp.status}`);
        if (resp.status === 429) {
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          continue;
        } else if (resp.status >= 500) {
          if (attempt < 3) await new Promise(r => setTimeout(r, 500));
          continue;
        } else {
          break;
        }
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        console.error(`reconcileOcrWithLLM: attempt ${attempt} returned empty or invalid content`);
        break;
      }
      return content.trim();
    } catch (err) {
      console.error(`reconcileOcrWithLLM: attempt ${attempt} threw`, err);
      if (attempt < 3) await new Promise(r => setTimeout(r, 200));
    }
  }
  return null;
}

// Why: Provides transparent OCR with automatic fallback so callers don't need to manage service availability.
// What: Tries polycr first; if 2+ engines returned results, feeds them all to the LLM for reconciliation
//       (best possible text). Falls back to consensus scoring (pickBestPolycr) if the LLM is unavailable.
//       Falls back to local Tesseract if polycr is unreachable.
// Test: Mock callPolycr to return two engine results; mock reconcileOcrWithLLM to return "reconciled";
//       assert engine_used is 'llm-reconciled' and text is "reconciled".
//       Mock reconcileOcrWithLLM to return null; assert engine_used is the consensus engine name.
//       Mock callPolycr to return null result; assert engine_used is 'tesseract-local'.
async function ocrWithFallback(filePath) {
  const { result, fallback_reason } = await callPolycr(filePath);
  if (result) {
    // Collect all engine results that produced usable text
    const engineResults = (result.results || [])
      .filter(r => r && typeof r.text === 'string' && !r.error && countWords(r.text) > 0)
      .map(r => ({ engine: r.engine || 'unknown', text: r.text }));

    // Try LLM reconciliation whenever at least 1 engine produced output.
    // Even a single engine result benefits from LLM correction of typos and proper nouns.
    if (engineResults.length >= 1) {
      const reconciled = await reconcileOcrWithLLM(engineResults);
      if (reconciled && countWords(reconciled) > 0) {
        return {
          text: reconciled,
          engine_used: 'llm-reconciled',
          confidence: 0.95,
          word_count: countWords(reconciled),
          empty: false,
          fallback_reason: undefined,
        };
      }
      console.error(`ocrWithFallback: LLM reconciliation returned null, falling back to pickBestPolycr`);
    }

    // LLM unavailable or only 1 engine — fall back to consensus scoring
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
  console.error(`ocrWithFallback: polycr unavailable (${fallback_reason || 'no result'}), falling back to local Tesseract`);
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

  // Check custom rules BEFORE property rules.
  // Why: Many documents are mailed to the customer's home address, so a property
  //      address match (e.g. "123 Sample Dr") would fire on an auto repair invoice
  //      addressed to David before the "subaru" vehicle rule ever runs. Custom rules
  //      represent what the document IS about; property rules represent where the
  //      customer lives — the former should win.
  // What: Iterates custom_rules; first keyword match returns immediately with rule.path
  //       (after substituting the most recent 4-digit year if detect_year is set).
  // Test: Add a rule with keywords:["subaru"] path:"/Auto/"; pass text containing both
  //       "subaru" and "123 sample dr"; assert type==="auto" and path==="/Auto/".
  for (const rule of (routingRules.custom_rules || [])) {
    const keywords = rule.keywords || [];
    if (keywords.some(kw => lower.includes(kw.toLowerCase()))) {
      let rulePath = rule.path;
      if (rule.detect_year && rulePath.includes('{year}')) {
        // Extract year from OCR text; prefer most recent plausible year (2000–currentYear+1)
        const yearMatch = text.match(/\b(20\d{2})\b/g);
        const currentYear = new Date().getFullYear();
        const years = (yearMatch || [])
          .map(y => parseInt(y))
          .filter(y => y >= 2000 && y <= currentYear + 1);
        const year = years.length > 0 ? Math.max(...years) : currentYear;
        rulePath = rulePath.replace('{year}', year);
      }
      return { type: rule.type || 'document', path: rulePath };
    }
  }

  // Check property-based routing after custom rules.
  // Why: Property address keywords (e.g. "123 sample dr") appear on many documents simply
  //      because they are the customer's mailing address — they should only route to a
  //      property folder when no more-specific document-type rule matched first.
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

// Why: Produces a human-readable filename slug via LLM so filenames reflect meaningful
//      document content (e.g. "Rocket_Mortgage_Statement") rather than OCR noise.
// What: POSTs the first 600 chars of OCR text plus classification hints to the LiteLLM
//       proxy and returns a sanitized 2-4 word underscore-separated TitleCase slug, or
//       null on any failure (timeout, HTTP error, empty/garbage response).
// Test: Mock fetch to return '{"choices":[{"message":{"content":"Verizon_Wireless_Bill"}}]}';
//       assert return value is "Verizon_Wireless_Bill".
//       Mock fetch to throw; assert return value is null.
// Why: Extracts both the document date and a vendor-identifying slug in one LLM call,
//      eliminating fragile regex date patterns that miss real-world date formats.
// What: Calls the LLM with a two-line response format; parses line 1 as YYYY-MM-DD date
//       and line 2 as a filename slug. Falls back to today's date if the date line is
//       missing or malformed.
// Test: Call with text containing "Invoice Date: November 7, 2025" from "DeCraenes Service
//       Center"; assert result is { date: '2025-11-07', slug: 'DeCraenes_Service_Center_Invoice' }.
async function generateFilenamePartsWithLLM(ocrText, classification) {
  const today = new Date().toISOString().split('T')[0];
  const snippet = ocrText.slice(0, 1200);
  const prompt =
    `You are a document filing assistant. Extract the document date and generate a filename slug.\n\n` +
    `Return EXACTLY two lines:\n` +
    `Line 1: The document date in ISO format YYYY-MM-DD.\n` +
    `Line 2: A filename slug: 2-4 words, underscores, TitleCase.\n\n` +
    `DATE RULES — be aggressive, not rigid:\n` +
    `- Search everywhere: invoice date, service date, date of service, statement date, order date, completed date, any date field\n` +
    `- Two-digit years: 08/25/25 = 2025-08-25, 07/21/25 = 2025-07-21 (years 00-30 = 20xx, 31-99 = 19xx)\n` +
    `- Long-form dates: "{Monday, August 25, 2025, 12:29 pm}" = 2025-08-25\n` +
    `- Abbreviated months: Nov 7 2025 = 2025-11-07, Dec. 3 2024 = 2024-12-03\n` +
    `- Noisy/handwritten OCR: make your best effort to interpret garbled date-like text near labels like "DATE:", "Date Ordered:", "Invoice Date:"\n` +
    `- Only return UNKNOWN if there is absolutely no date-related text anywhere in the document\n\n` +
    `SLUG RULES:\n` +
    `- MUST start with the business or vendor name from the OCR text (who sent or performed the service)\n` +
    `- Do NOT use vehicle make/model — those are filing destinations, not vendors\n` +
    `- Remove apostrophes (O'Connor → OConnor)\n` +
    `- "${classification.path}" is routing only, not the filename source\n\n` +
    `Examples:\n` +
    `2025-08-25\nDeCraenes_Service_Center_Invoice\n\n` +
    `2025-07-21\nDeCraenes_Service_Center_Invoice\n\n` +
    `UNKNOWN\nOConnor_Electric_Invoice\n\n` +
    `OCR text:\n${snippet}`;

  let raw = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000);
      let resp;
      try {
        resp = await fetch(LITELLM_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${LITELLM_KEY}`,
          },
          body: JSON.stringify({
            model: LITELLM_MODEL,
            messages: [
              { role: 'system', content: 'You are a document filing assistant. You generate short filename slugs that identify WHO issued the document, not WHERE it was filed.' },
              { role: 'user', content: prompt },
            ],
            max_tokens: 64,
            temperature: 0,
          }),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) {
        console.error(`generateFilenamePartsWithLLM: attempt ${attempt} failed with HTTP ${resp.status}`);
        if (resp.status === 429) {
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          continue;
        } else if (resp.status >= 500) {
          if (attempt < 3) await new Promise(r => setTimeout(r, 500));
          continue;
        } else {
          break;
        }
      }
      const data = await resp.json();
      const candidate = data?.choices?.[0]?.message?.content;
      if (!candidate || typeof candidate !== 'string') {
        console.error(`generateFilenamePartsWithLLM: attempt ${attempt} returned empty or invalid content`);
        break;
      }
      raw = candidate;
      break;
    } catch (err) {
      console.error(`generateFilenamePartsWithLLM: attempt ${attempt} threw`, err);
      if (attempt < 3) await new Promise(r => setTimeout(r, 200));
    }
  }

  if (!raw) return null;

  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return null;

  const dateLine = lines[0];
  const slugLine = lines[1];

  // If date line is UNKNOWN, return null date so caller falls through to regex chain.
  // If date line is a valid ISO date, use it. Otherwise treat as unknown.
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(dateLine);
  const date = dateValid ? dateLine : null;

  const slug = slugLine
    .replace(/['\u2018\u2019\u02BC]/g, '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);

  if (slug.length < 3) return null;
  // Return slug always; date may be null (caller will run regex fallback for date).
  return { date, slug };
}

// Why: Produces consistent, date-prefixed filenames from OCR text so documents are
//      sortable by date without manual renaming.
// What: Tries LLM-based date+slug extraction first (one call); falls back to regex date
//       extraction and extractTitleSlug heuristics on any LLM failure.
// Test: Call with text="SUMMER ENRICHMENT PROGRAM\nJune 1, 2026" ext="pdf";
//       assert result starts with "2026-06-01_".
async function generateFilename(text, classification, description, ext) {
  // Try LLM-based date+slug extraction first (one call for both fields).
  // llmParts.date may be null if LLM returned UNKNOWN — in that case fall through
  // to regex date extraction below but still use the LLM slug.
  const llmParts = await generateFilenamePartsWithLLM(text, classification);
  if (llmParts?.date) {
    return `${llmParts.date}_${llmParts.slug}.${ext}`;
  }

  // Regex date extraction — runs when LLM is unavailable or returned UNKNOWN date.
  const months = {
    january:'01', february:'02', march:'03',    april:'04',
    may:'05',     june:'06',     july:'07',      august:'08',
    september:'09', october:'10', november:'11', december:'12',
    jan:'01', feb:'02', mar:'03', apr:'04',
    jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12',
  };

  let dateStr = null;
  const m1  = text.match(/\b(\d{4})[\/\-](\d{2})[\/\-](\d{2})\b/);
  const m2  = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
  const m3  = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i);
  const m3b = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2}),?\s+(\d{4})\b/i);
  const m3c = text.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{4})\b/i);
  const m2b = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})\b/);

  // m1: ISO-style YYYY-MM-DD — validate year, month, day ranges
  if (m1) {
    const yr = parseInt(m1[1], 10);
    const mo = parseInt(m1[2], 10);
    const dy = parseInt(m1[3], 10);
    if (yr >= 1900 && yr <= 2099 && mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
      dateStr = `${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`;
    }
  }
  // m2: US-style MM/DD/YYYY — validate month, day, year ranges
  if (!dateStr && m2) {
    const mo = parseInt(m2[1], 10);
    const dy = parseInt(m2[2], 10);
    const yr = parseInt(m2[3], 10);
    if (yr >= 1900 && yr <= 2099 && mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
      dateStr = `${m2[3]}-${m2[1].padStart(2, '0')}-${m2[2].padStart(2, '0')}`;
    }
  }
  // m3: long-form "Month D, YYYY"
  if (!dateStr && m3) {
    const yr = parseInt(m3[3], 10);
    if (yr >= 1900 && yr <= 2099) {
      dateStr = `${m3[3]}-${months[m3[1].toLowerCase()]}-${m3[2].padStart(2, '0')}`;
    }
  }
  // m3b: abbreviated month "Nov 7, 2025" or "Nov. 7, 2025"
  if (!dateStr && m3b) {
    const yr = parseInt(m3b[3], 10);
    const key = m3b[1].toLowerCase().replace('.', '');
    if (yr >= 1900 && yr <= 2099 && months[key]) {
      dateStr = `${m3b[3]}-${months[key]}-${m3b[2].padStart(2, '0')}`;
    }
  }
  // m3c: day-first abbreviated "7 Nov 2025" or "15 Jan 2026"
  if (!dateStr && m3c) {
    const yr = parseInt(m3c[3], 10);
    const key = m3c[2].toLowerCase().replace('.', '');
    if (yr >= 1900 && yr <= 2099 && months[key]) {
      dateStr = `${m3c[3]}-${months[key]}-${m3c[1].padStart(2, '0')}`;
    }
  }
  // m2b: two-digit year US-style "11/07/25" or "1/15/26"
  if (!dateStr && m2b) {
    const mo = parseInt(m2b[1], 10);
    const dy = parseInt(m2b[2], 10);
    const rawYr = parseInt(m2b[3], 10);
    const yr = rawYr <= 30 ? 2000 + rawYr : 1900 + rawYr;
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
      dateStr = `${yr}-${m2b[1].padStart(2, '0')}-${m2b[2].padStart(2, '0')}`;
    }
  }
  // fallback: today
  if (!dateStr) dateStr = new Date().toISOString().split('T')[0];

  // If LLM gave us a slug (even though its date was UNKNOWN), use it.
  if (llmParts?.slug) {
    return `${dateStr}_${llmParts.slug}.${ext}`;
  }

  let slug;
  {
    const ocrTitle = extractTitleSlug(text);
    // If the OCR title is too short after slug-cleaning (token fallback produced < 5 chars),
    // prefer the caller-supplied description which is usually more informative.
    const ocrTitleCleaned = ocrTitle.replace(/[^a-zA-Z0-9]/g, '');
    if (ocrTitle && ocrTitleCleaned.length >= 5) {
      slug = ocrTitle;
    } else if (description) {
      slug = description;
    } else if (ocrTitle) {
      slug = ocrTitle;
    } else {
      slug = classification.type;
    }
  }
  slug = slug.trim()
    // Normalize OCR camelCase concatenation artifacts before splitting.
    // Pattern: two uppercase letters followed by a lowercase letter (e.g. "CCenter",
    // "SService") means a stray capital was merged with the next word. Insert a space
    // so "CCenter" → "C Center" and the single-char "C" gets filtered below.
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[\s\-_]+/)
    .map(w => {
      // Strip leading/trailing non-alphanumeric chars before title-casing so that
      // tokens like "Inc." become "Inc" and "C." becomes "C" (then filtered below).
      // This prevents trailing punctuation from gluing adjacent tokens (e.g. "C.Center"
      // staying as one token and producing "Ccenter" after the non-alnum strip).
      const clean = w.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
      if (!clean) return '';
      return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
    })
    // Drop empty strings and single-character tokens — isolated letters are almost always
    // OCR noise (a stray "C" split off from "Center", an ampersand residue, etc.)
    .filter(w => w.length > 1)
    .join('_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/, '')
    .slice(0, 60);

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
    // Reject street address lines (e.g. "S Eastwood Drive", "1421 W Lake Shore Blvd")
    const roadTypes = /\b(street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|lane|ln|way|court|ct|place|pl|parkway|pkwy|circle|cir|trail|trl)\b/i;
    const addressPrefixes = /^(north|south|east|west|n|s|e|w)\b/i;
    if (roadTypes.test(line) && (addressPrefixes.test(line) || /^\d/.test(line))) return true;
    // Reject common form-field label phrases
    const formLabels = /^(work\s+authorized|authorized\s+by|customer\s+signature|date\s+of\s+service|service\s+advisor|vehicle\s+in|vehicle\s+out|mileage\s+in|mileage\s+out|license\s+plate|vin\s+number|technician|print\s+name|signature)\b/i;
    if (formLabels.test(line)) return true;
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

  // Heuristic 0: ALL-CAPS company name + following document-type line.
  // Why: Financial documents typically lead with "COMPANY NAME\nDocument Type"
  //      e.g. "ROCKET MORTGAGE\nAutopay Confirmation" or "CHASE BANK\nAccount Summary".
  //      Combining both lines produces a more descriptive slug than either alone.
  // What: Finds the first ALL-CAPS line (1–4 words) in first 10 lines as company,
  //       then looks at the next 1–3 lines for a title-case or mixed-case doc-type
  //       line (1–5 words, not noise, not stop-word-heavy, not another ALL-CAPS line).
  // Test: Pass "ROCKET MORTGAGE\nAutopay Confirmation\nDear Customer" →
  //       expect "ROCKET MORTGAGE Autopay Confirmation".
  let companyLine = null;
  let companyIdx  = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const line = lines[i];
    const wc   = wordCount(line);
    if (wc >= 1 && wc <= 4 && line === line.toUpperCase() && /[A-Z]/.test(line) && !isNoiseLine(line)) {
      companyLine = line;
      companyIdx  = i;
      break;
    }
  }
  if (companyLine !== null) {
    for (let j = companyIdx + 1; j < Math.min(lines.length, companyIdx + 4); j++) {
      const next = lines[j];
      const wc   = wordCount(next);
      if (
        wc >= 1 && wc <= 5 &&
        next !== next.toUpperCase() &&   // not another ALL-CAPS line
        !isNoiseLine(next) &&
        !isStopWordHeavy(next)
      ) {
        return `${companyLine} ${next}`;
      }
    }
    // Found company but no good doc-type line — return company name alone
    return companyLine;
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

// Why: Scans all ADF pages via the Canon eSCL HTTP API directly, bypassing scanimage.
//      scanimage (both per-call loop and --batch) behaves incorrectly with eSCL: each
//      new SANE session triggers a new eSCL scan job, causing the Canon to feed the
//      entire ADF stack but only deliver page 1 per job. Calling NextDocument within a
//      single job gives proper per-page control.
// What: POSTs a ScanJobs request, then GETs NextDocument in a loop until 404 (ADF
//       empty). Each page is saved as a numbered JPEG. Cleans up the eSCL job on exit.
//       Returns array of absolute JPEG paths in page order.
// Test: Mock fetch to return 201 with Location header, then 200 for 2 pages, then 404;
//       assert return value has 2 file paths and both files contain the mocked JPEG data.

// Why: Canon MF741C returns HTTP 500 on POST /eSCL/ScanJobs if a previous job is still
//      registered (zombie job from a crashed/killed process that skipped its finally-DELETE).
//      This pre-flight clears any active/processing jobs so the next POST succeeds.
// What: GETs /eSCL/ScannerStatus, parses ALL JobUri elements regardless of job state,
//       fires DELETE on each, waits 500ms for the printer to release the job lock, then returns.
//       Errors are swallowed — if we can't clear, we proceed anyway and let the POST fail
//       with a meaningful error rather than hanging here.
// Test: Mock ScannerStatus to return XML with a JobUri, assert DELETE is called on that URI;
//       mock ScannerStatus to return non-OK, assert function returns without throwing.
async function clearStuckEsclJobs() {
  try {
    const statusResp = await fetch(`${CANON_ESCL_BASE}/eSCL/ScannerStatus`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!statusResp.ok) return;
    const xml = await statusResp.text();

    // Extract all JobUri values — these are the active/processing job URLs
    const jobUriMatches = xml.matchAll(/<(?:[^:>]+:)?JobUri>([^<]+)<\/(?:[^:>]+:)?JobUri>/g);
    const jobUris = [...jobUriMatches].map(m => m[1].trim());
    if (jobUris.length === 0) return;

    // DELETE each stuck job (fire-and-forget per job, but await all)
    await Promise.allSettled(
      jobUris.map(uri => {
        const url = uri.startsWith('http') ? uri : `${CANON_ESCL_BASE}${uri}`;
        return fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(3000) });
      })
    );

    // Brief pause for the printer to release the job lock
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch {
    // Non-fatal — proceed with the scan attempt
  }
}

async function scanAdfViaEscl(timestamp, colorMode, resolution) {
  await clearStuckEsclJobs();
  const scanXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03"',
    '                   xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">',
    '  <pwg:Version>2.63</pwg:Version>',
    '  <scan:Intent>Document</scan:Intent>',
    '  <pwg:ScanRegions pwg:MustHonor="false">',
    '    <pwg:ScanRegion>',
    '      <pwg:Height>3300</pwg:Height>',
    '      <pwg:Width>2550</pwg:Width>',
    '      <pwg:XOffset>0</pwg:XOffset>',
    '      <pwg:YOffset>0</pwg:YOffset>',
    '    </pwg:ScanRegion>',
    '  </pwg:ScanRegions>',
    '  <pwg:InputSource>Feeder</pwg:InputSource>',
    `  <scan:ColorMode>${colorMode === 'Color' ? 'RGB24' : 'Grayscale8'}</scan:ColorMode>`,
    `  <scan:XResolution>${resolution}</scan:XResolution>`,
    `  <scan:YResolution>${resolution}</scan:YResolution>`,
    '  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>',
    '</scan:ScanSettings>',
  ].join('\n');

  // Create scan job
  const createResp = await fetch(`${CANON_ESCL_BASE}/eSCL/ScanJobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: scanXml,
  });

  if (!createResp.ok) {
    const body = await createResp.text().catch(() => '');
    throw new Error(`eSCL job creation failed: HTTP ${createResp.status} — ${body.slice(0, 200)}`);
  }

  const location = createResp.headers.get('location');
  if (!location) throw new Error('eSCL: no Location header in job creation response');
  const jobUrl = location.startsWith('http') ? location : `${CANON_ESCL_BASE}${location}`;

  const pageJpegs = [];
  try {
    for (let pageNum = 1; pageNum <= 99; pageNum++) {
      // 90s per-page timeout — Canon can be slow to scan and compress
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 90000);
      let pageResp;
      try {
        pageResp = await fetch(`${jobUrl}/NextDocument`, { signal: ac.signal });
      } finally {
        clearTimeout(timer);
      }

      // 404 = ADF empty (job complete); 503 = scanner busy / job cancelled
      if (pageResp.status === 404 || pageResp.status === 503) break;

      if (!pageResp.ok) {
        // Unexpected error mid-batch — if we have pages already, treat as done
        if (pageJpegs.length > 0) break;
        throw new Error(`eSCL NextDocument failed: HTTP ${pageResp.status}`);
      }

      const pageData = Buffer.from(await pageResp.arrayBuffer());
      if (pageData.length === 0) break;

      const pageFile = `/tmp/scan_${timestamp}_p${pageNum}.jpg`;
      fs.writeFileSync(pageFile, pageData);
      pageJpegs.push(pageFile);
    }
  } finally {
    // Always clean up the eSCL job — fire-and-forget, errors don't matter
    fetch(jobUrl, { method: 'DELETE' }).catch(() => {});
  }

  return pageJpegs;
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

// Why: Needed by split_and_refile to fetch an existing Nextcloud PDF to /tmp.
// What: HTTP GET via WebDAV, writes buffer to outputPath.
async function nextcloudDownload(ncFullPath, outputPath) {
  const url = `${NEXTCLOUD_WEBDAV_BASE}${ncFullPath}`;
  const auth = 'Basic ' + Buffer.from(`${NEXTCLOUD_USER}:${NEXTCLOUD_PASSWORD}`).toString('base64');
  const resp = await fetch(url, { method: 'GET', headers: { Authorization: auth } });
  if (!resp.ok) throw new Error(`Nextcloud download failed: HTTP ${resp.status} for ${ncFullPath}`);
  fs.writeFileSync(outputPath, Buffer.from(await resp.arrayBuffer()));
}

// Why: Needed by split_and_refile to remove the original merged PDF after refiling.
// What: WebDAV DELETE — returns true on success, throws on unexpected error.
async function nextcloudDelete(ncFullPath) {
  const url = `${NEXTCLOUD_WEBDAV_BASE}${ncFullPath}`;
  const auth = 'Basic ' + Buffer.from(`${NEXTCLOUD_USER}:${NEXTCLOUD_PASSWORD}`).toString('base64');
  const resp = await fetch(url, { method: 'DELETE', headers: { Authorization: auth } });
  if (!resp.ok && resp.status !== 204 && resp.status !== 404) {
    throw new Error(`Nextcloud DELETE failed: HTTP ${resp.status}`);
  }
  return true;
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
        "Scan a single page to a local file path using scanimage. Low-level tool — use scan_and_file instead for the full pipeline (OCR + PDF + Nextcloud). Returns success, path, scanner used.",
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
            description: "Scanner to use. canon-mf741c = Canon MF741C (primary, ADF+flatbed). hp-officejet-5740 = HP Officejet 5740 (backup flatbed). Default: canon-mf741c",
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
        "Scan a document and file it to Nextcloud automatically. Full pipeline: scan → OCR → searchable PDF → auto-classify → upload. Only `profile` is required; all other parameters have defaults. Default scanner is canon-mf741c. Returns filename, filed_at path, pdf_method, word_count, and confidence.",
      inputSchema: {
        type: "object",
        properties: {
          profile: {
            type: "string",
            enum: ["doc-bw", "doc-bw-adf", "doc-color", "receipt", "id-card", "photo", "event"],
            description: "Scanning profile. doc-bw-adf = Canon ADF feeder B&W (default for multi-page). doc-bw = flatbed B&W single page. doc-color = flatbed color. receipt = receipt flatbed. id-card = ID/insurance card flatbed. photo = photo flatbed. event = event flyer flatbed.",
          },
          description: {
            type: "string",
            description: "Optional hint for filename and classification (e.g. 'verizon bill april 2026', 'theodore immunization'). Improves auto-naming accuracy.",
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
            description: "ADF only: file each ADF page as a separate document. Default false (merge all pages into one PDF).",
          },
          scanner: {
            type: "string",
            enum: ["hp-officejet-5740", "canon-mf741c"],
            description: "Scanner to use. canon-mf741c = Canon MF741C (primary, ADF+flatbed). hp-officejet-5740 = HP Officejet 5740 (backup flatbed). Default: canon-mf741c",
          },
        },
        required: ["profile"],
      },
    },
    {
      name: "quick_scan",
      description: "Scan whatever is in the Canon MF741C ADF (or flatbed if ADF empty) and file to Nextcloud automatically. Zero configuration needed — uses Canon MF741C + doc-bw-adf profile + auto-classification. Returns filed_at path and OCR preview.",
      inputSchema: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "Optional hint for filename (e.g. 'verizon bill')",
          },
        },
      },
    },
    {
      name: "nextcloud_move",
      description: "Move or rename a file already in Nextcloud using WebDAV MOVE. Use this to rename a badly-named scan without re-scanning. source_path and dest_path are full paths relative to the user root (e.g. /Personal/Housing/123-Sample-Dr/Mortage/old.pdf). Returns success and the new full URL.",
      inputSchema: {
        type: "object",
        properties: {
          source_path: {
            type: "string",
            description: "Current full path in Nextcloud (e.g. /Personal/Housing/123-Sample-Dr/Mortage/2025-11-15_bad-name.pdf)",
          },
          dest_path: {
            type: "string",
            description: "New full path in Nextcloud (e.g. /Personal/Housing/123-Sample-Dr/Mortage/2025-11-15_rocket-mortgage.pdf). Must be in the same folder for a rename.",
          },
        },
        required: ["source_path", "dest_path"],
      },
    },
    {
      name: "split_and_refile",
      description: "Split an already-filed multi-page PDF in Nextcloud into individual pages, OCR and classify each page, and refile them as separate documents. Use this when a batch ADF scan was merged into one PDF but the pages should have been filed individually. Returns an array of per-page results.",
      inputSchema: {
        type: "object",
        properties: {
          source_path: {
            type: "string",
            description: "Full Nextcloud path of the PDF to split, including filename. Example: /Personal/Auto/Subaru Outback/2026-04-19_Decraenes_Service_Center_Inc.pdf",
          },
          delete_original: {
            type: "boolean",
            description: "Delete the original merged PDF from Nextcloud after all pages are successfully refiled. Default: false. Only deletes if every page succeeded.",
          },
          description: {
            type: "string",
            description: "Optional hint for classification and filename generation, applied to every page (e.g. 'DeCraenes invoice').",
          },
        },
        required: ["source_path"],
      },
    },
    {
      name: "ocr_inbound_media",
      description: "OCR an image that was attached via the OpenClaw web GUI. When a user attaches a photo or image in the chat, it lands in the media/inbound directory. Call this tool immediately — do not try to use vision. Pass the media_id extracted from the '[media attached: media://inbound/<id>]' marker in the message, or omit it to use the most recently uploaded file. Returns OCR text, engine used, confidence, and word count.",
      inputSchema: {
        type: "object",
        properties: {
          media_id: {
            type: "string",
            description: "The ID from 'media://inbound/<id>' in the message text. If omitted, uses the most recently modified file in the inbound directory.",
          },
          file_nextcloud: {
            type: "boolean",
            description: "If true, also create a searchable PDF and file to Nextcloud using auto-classification. Default false.",
          },
          description: {
            type: "string",
            description: "Optional hint for classification and filename if file_nextcloud is true.",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;

  // Why: Resets the MCP SDK client's 60s timeout window so long-running ADF scans
  //      are not cancelled mid-operation. Each notification extends the window.
  // What: Sends a notifications/progress message via the request-scoped sendNotification.
  //       Uses the progressToken from the request _meta when present; falls back to a
  //       generated string token so the notification is always well-formed.
  // Test: Spy on extra.sendNotification; call sendProgress(1, 5); assert it was called
  //       with method 'notifications/progress' and params.progress === 1.
  async function sendProgress(progress, total = -1, message = '') {
    try {
      const progressToken = request.params._meta?.progressToken ?? `scan_progress_${Date.now()}`;
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress, total, ...(message ? { message } : {}) },
      });
    } catch (_) {
      // Progress notification failure is non-fatal — never abort the scan.
    }
  }

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
      scanner = 'canon-mf741c',
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
        `scanimage --device-name=${JSON.stringify(deviceName)} --format=${format} --output-file=${JSON.stringify(output_path)} --resolution=${resolution} --mode=${JSON.stringify(mode)} --source=${JSON.stringify(source)}`,
        { timeout: 120000 }
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

  if (name === "scan_and_file" || name === "quick_scan") {
    // Why: Executes the full scan→OCR→PDF→upload pipeline atomically so a context
    //      bootstrap reset cannot interrupt it between steps.
    // What: Scans via scanimage, OCRs via polycr (Tesseract fallback), creates a
    //       searchable PDF via ocrmypdf service (Tesseract fallback), uploads to
    //       Nextcloud WebDAV, cleans up temp files, returns a summary object.
    //       quick_scan is a zero-config alias: canon-mf741c + doc-bw-adf defaults.
    // Test: Mock execSync for scanimage success; mock fetch for polycr and ocrmypdf;
    //       assert result.success is true, result.filed_at is non-null, and temp
    //       files are deleted by the end of the call.
    const resolvedArgs = name === "quick_scan"
      ? { profile: 'doc-bw-adf', scanner: 'canon-mf741c', ...(args.description ? { description: args.description } : {}) }
      : args;
    const { profile, description, nextcloud_path: ncPathOverride, filename: filenameOverride, separate_pages = false, scanner = 'canon-mf741c' } = resolvedArgs;
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
      let ocrEngineUsed = null;
      let ocrFallbackReason = null;

      if (profile !== 'photo') {
        const ocrResult = await ocrWithFallback(tmpJpeg);
        ocrText = ocrResult.text || '';
        wordCount = ocrResult.word_count || 0;
        confidence = ocrResult.confidence || 0;
        ocrEngineUsed = ocrResult.engine_used || null;
        ocrFallbackReason = ocrResult.fallback_reason || null;

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
              ocrEngineUsed = enhancedResult.engine_used || null;
              ocrFallbackReason = enhancedResult.fallback_reason || null;
            }
          } catch (_) {
            // enhancement failed — keep original OCR result
          }
        }
      }

      // Step 3: Classify + generate filename (deduplicate same-second collisions)
      const classification = classifyDocumentForFiling(ocrText, profile, description);
      const ext = profile === 'photo' ? 'jpg' : 'pdf';
      let baseFilename = filenameOverride || await generateFilename(ocrText, classification, description || '', ext);
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
        engine_used: ocrEngineUsed || undefined,
        fallback_reason: ocrFallbackReason || undefined,
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

        // Step 1: Collect all page JPEGs from ADF using direct eSCL HTTP API.
        //
        // Why eSCL instead of scanimage:
        //   Each new `scanimage` invocation creates a fresh eSCL scan job. The Canon
        //   feeds ALL remaining ADF pages for that job, but since JPEG is single-frame,
        //   only page 1 is written per invocation. `scanimage --batch` was tested and
        //   confirmed non-functional with the airscan backend (scanner reports 4 images
        //   completed but no files are written to disk).
        //
        //   Direct eSCL: one POST /eSCL/ScanJobs creates a job, then repeated GET
        //   {jobUrl}/NextDocument fetches each page in sequence until the feeder
        //   returns 404 or 503 (end of feed). This is the only reliable multi-page
        //   ADF approach for the Canon MF741C.

        await sendProgress(0, -1, 'ADF scan starting — warming up scanner');

        const pageJpegs = await scanAdfViaEscl(timestamp, scanMode, 300);
        for (const f of pageJpegs) allTempFiles.push(f);

        if (pageJpegs.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'ADF feeder was empty — no pages scanned.' }) }],
            isError: true,
          };
        }

        await sendProgress(pageJpegs.length, pageJpegs.length, `${pageJpegs.length} page(s) scanned`);

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
        let ocrEngineUsed = null;
        let ocrFallbackReason = null;

        if (profile !== 'photo') {
          const ocrResult = await ocrWithFallback(pageJpegs[0]);
          ocrText = ocrResult.text || '';
          wordCount = ocrResult.word_count || 0;
          confidence = ocrResult.confidence || 0;
          ocrEngineUsed = ocrResult.engine_used || null;
          ocrFallbackReason = ocrResult.fallback_reason || null;

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
                ocrEngineUsed = enhancedResult.engine_used || null;
                ocrFallbackReason = enhancedResult.fallback_reason || null;
              }
            } catch (_) {
              // enhancement failed — keep original OCR result
            }
          }
        }

        // Step 3: Classify + generate filename from page 1 OCR
        const classification = classifyDocumentForFiling(ocrText, profile, description);
        const ext = profile === 'photo' ? 'jpg' : 'pdf';
        const filename = filenameOverride || await generateFilename(ocrText, classification, description || '', ext);
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
                if (pdfBuf.length < 5 || pdfBuf.slice(0, 5).toString('ascii') !== '%PDF-') {
                  throw new Error(`polycr service returned non-PDF response (${pdfBuf.length} bytes)`);
                }
                fs.writeFileSync(ocrPdf, pdfBuf);
                fileToUpload = ocrPdf;
                pdfMethod = 'polycr';
              } else {
                throw new Error(`ocrmypdf service HTTP ${pdfResp.status}`);
              }
            } catch (_remoteErr) {
              // Fallback: ocrmypdf CLI on the already-merged PDF
              try {
                await execFileAsync('ocrmypdf', ['--rotate-pages', '--deskew', '--optimize', '1', '--image-dpi', '300', mergedPdf, ocrPdf]);
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
          engine_used: ocrEngineUsed || undefined,
          fallback_reason: ocrFallbackReason || undefined,
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
          { timeout: 120000 }
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

  if (name === "nextcloud_move") {
    const { source_path, dest_path } = args;
    const auth = 'Basic ' + Buffer.from(`${NEXTCLOUD_USER}:${NEXTCLOUD_PASSWORD}`).toString('base64');
    const sourceUrl = `${NEXTCLOUD_WEBDAV_BASE}${source_path}`;
    const destUrl   = `${NEXTCLOUD_WEBDAV_BASE}${dest_path}`;

    const resp = await fetch(sourceUrl, {
      method: 'MOVE',
      headers: {
        Authorization: auth,
        Destination: destUrl,
        Overwrite: 'F',
      },
    });

    if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
      throw new Error(`Nextcloud MOVE failed: HTTP ${resp.status}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: true, moved_to: destUrl }),
      }],
    };
  }

  if (name === "split_and_refile") {
    const { source_path, delete_original = false, description } = args || {};
    const timestamp = Date.now();
    const allTempFiles = [];

    async function sendProgress(progress, total = -1, message = '') {
      const progressToken = request.params._meta?.progressToken ?? `split_progress_${timestamp}`;
      try {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress, total, ...(message ? { message } : {}) },
        });
      } catch (_) {}
    }

    try {
      // Validate
      if (!source_path || typeof source_path !== 'string') {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'source_path is required.' }) }], isError: true };
      }
      if (!source_path.toLowerCase().endsWith('.pdf')) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'source_path must point to a .pdf file.' }) }], isError: true };
      }

      // Download PDF from Nextcloud
      await sendProgress(0, -1, 'Downloading PDF from Nextcloud');
      const sourcePdf = `/tmp/split_${timestamp}_source.pdf`;
      allTempFiles.push(sourcePdf);
      try {
        await nextcloudDownload(source_path, sourcePdf);
      } catch (dlErr) {
        const msg = dlErr.message.includes('404') || dlErr.message.includes('HTTP 404')
          ? `File not found at ${source_path}`
          : `Download failed: ${dlErr.message}`;
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }

      // Get page count via pdfinfo (purpose-built, no rendering required)
      let pageCount;
      try {
        const pdfInfoOut = execSync(`pdfinfo ${JSON.stringify(sourcePdf)} 2>/dev/null`, { timeout: 10000 }).toString();
        const pagesMatch = pdfInfoOut.match(/^Pages:\s+(\d+)/m);
        pageCount = pagesMatch ? parseInt(pagesMatch[1], 10) : 0;
        if (!pageCount || pageCount < 1) throw new Error('pdfinfo returned 0 pages');
      } catch (_) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not determine page count — is this a valid PDF?' }) }], isError: true };
      }

      // Single-page edge case
      if (pageCount === 1 && !delete_original) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false,
            error: 'This PDF has only 1 page — nothing to split. To move it to a different folder use ocr__nextcloud_move instead.',
            pages: 1,
          }) }],
        };
      }

      // Split all pages at once via pdfseparate (preserves internal PDF structure, no re-encoding).
      // gs -sDEVICE=pdfwrite was previously used here but it re-renders the PDF — while it does
      // NOT corrupt ToUnicode CMaps, pdfseparate is faster and more appropriate for this task.
      await sendProgress(0, pageCount, `${pageCount} page(s) found — splitting`);
      const splitPattern = `/tmp/split_${timestamp}_p%d.pdf`;
      execSync(`pdfseparate ${JSON.stringify(sourcePdf)} ${JSON.stringify(splitPattern)}`, { timeout: 60000 });

      const usedFilenames = new Set();
      const results = [];
      let anyFailed = false;

      for (let i = 1; i <= pageCount; i++) {
        const splitPdf  = `/tmp/split_${timestamp}_p${i}.pdf`;
        const splitJpeg = `/tmp/split_${timestamp}_p${i}.jpg`;
        allTempFiles.push(splitPdf, splitJpeg);

        try {
          // Step A: Extract text via pdftotext (poppler).
          // Root cause of the previous gs txtwrite failure: ocrmypdf/Tesseract text layers store
          // each character at its exact pixel coordinate. gs txtwrite dumps chars in stream order
          // (diagonal garbage). pdftotext reconstructs reading order from position data correctly.
          await sendProgress(i - 1, pageCount, `Page ${i} of ${pageCount} — extracting text`);
          let ocrText = '';
          let wordCount = 0;
          let confidence = 0;
          let pdfMethod = 'existing-text-layer';
          try {
            ocrText = execSync(`pdftotext ${JSON.stringify(splitPdf)} -`, { timeout: 10000 }).toString().trim();
            wordCount = countWords(ocrText);
            confidence = wordCount > 0 ? 0.9 : 0;
          } catch (_) {}

          // Step C: Fallback to full JPEG OCR if text layer is empty or sparse
          // (handles image-only PDFs that were scanned without OCR originally)
          if (wordCount < 10) {
            await sendProgress(i - 1, pageCount, `Page ${i} of ${pageCount} — OCR (no text layer)`);
            allTempFiles.push(splitJpeg);
            execSync(
              `convert -density 300 ${JSON.stringify(splitPdf)}[0] -quality 85 ${JSON.stringify(splitJpeg)}`,
              { timeout: 30000 }
            );
            const ocrResult = await ocrWithFallback(splitJpeg);
            if ((ocrResult.word_count || 0) > wordCount) {
              ocrText = ocrResult.text || '';
              wordCount = ocrResult.word_count || 0;
              confidence = ocrResult.confidence || 0;
              pdfMethod = ocrResult.engine_used || 'ocr-fallback';
            }
          }

          // Step D: Classify and generate filename.
          // description is passed to classifyDocumentForFiling as a routing hint, but NOT
          // to generateFilename — each page names itself from its own text. Passing the
          // batch description to generateFilename causes pages with sparse text to inherit
          // the description slug (e.g. page 4 with no DeCraenes text gets named "Decraenes").
          await sendProgress(i - 1, pageCount, `Page ${i} of ${pageCount} — classifying`);
          const classification = classifyDocumentForFiling(ocrText, 'doc-bw', description);
          let filename = await generateFilename(ocrText, classification, '', 'pdf');

          // Collision safety across pages
          let attempt = 0;
          while (usedFilenames.has(filename)) {
            attempt++;
            const base = filename.replace(/\.pdf$/, '');
            filename = `${base}_p${i}${attempt > 1 ? `_${attempt}` : ''}.pdf`;
          }
          usedFilenames.add(filename);

          // Step E: Upload split PDF directly — it already has a text layer, no re-OCR needed
          await sendProgress(i - 1, pageCount, `Page ${i} of ${pageCount} — uploading`);
          const ncPath = classification.path || '/Inbox/';
          await nextcloudUpload(splitPdf, ncPath, filename);

          const inboxFlag = ncPath === '/Inbox/' ? 'Could not classify — filed to /Inbox/' : undefined;

          results.push({
            page: i,
            success: true,
            filename,
            filed_at: `${ncPath}${filename}`,
            document_type: classification.type,
            pdf_method: pdfMethod,
            word_count: wordCount,
            confidence: Math.round(confidence * 100) / 100,
            ocr_preview: ocrText.slice(0, 200).trim() || null,
            ...(inboxFlag ? { note: inboxFlag } : {}),
          });

        } catch (pageErr) {
          anyFailed = true;
          results.push({ page: i, success: false, error: pageErr.message });
        }
      }

      // Delete original if requested and all pages succeeded
      let originalDeleted = false;
      let deleteNote;
      if (delete_original) {
        if (anyFailed) {
          deleteNote = 'Original preserved — one or more pages failed to refile.';
        } else {
          try {
            await nextcloudDelete(source_path);
            originalDeleted = true;
          } catch (delErr) {
            deleteNote = `Original deletion failed: ${delErr.message}`;
          }
        }
      }

      await sendProgress(pageCount, pageCount, 'Done');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            pages_processed: pageCount,
            pages_succeeded: results.filter(r => r.success).length,
            original_deleted: originalDeleted,
            ...(deleteNote ? { delete_note: deleteNote } : {}),
            results,
          }),
        }],
      };

    } finally {
      for (const f of allTempFiles) {
        try { execSync(`rm -f ${JSON.stringify(f)}`); } catch (_) {}
      }
    }
  }

  if (name === "ocr_inbound_media") {
    const { media_id, file_nextcloud = false, description } = args || {};
    const inboundDir = path.join(os.homedir(), '.openclaw', 'media', 'inbound');

    // Find the target file
    let targetFile = null;
    if (media_id) {
      // Search for file whose name contains the media_id
      const files = fs.readdirSync(inboundDir).filter(f => f.includes(media_id));
      if (files.length > 0) {
        targetFile = path.join(inboundDir, files[0]);
      }
    }
    if (!targetFile) {
      // Fall back to most recently modified file
      const files = fs.readdirSync(inboundDir)
        .map(f => ({ name: f, mtime: fs.statSync(path.join(inboundDir, f)).mtimeMs }))
        .filter(f => /\.(jpg|jpeg|png|tiff?|bmp|webp)$/i.test(f.name))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No image files found in media/inbound. Please attach an image first.' }) }],
          isError: true,
        };
      }
      targetFile = path.join(inboundDir, files[0].name);
    }

    // Run OCR via polycr with fallback
    const ocrResult = await ocrWithFallback(targetFile);

    if (!file_nextcloud) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            source_file: path.basename(targetFile),
            text: ocrResult.text || '',
            engine_used: ocrResult.engine_used,
            confidence: ocrResult.confidence,
            word_count: ocrResult.word_count || 0,
            empty: !ocrResult.text || ocrResult.word_count === 0,
          }),
        }],
      };
    }

    // file_nextcloud=true: create searchable PDF and upload
    const timestamp = Date.now();
    const tmpPdf = `/tmp/inbound_${timestamp}.pdf`;
    try {
      const pdfResult = await createSearchablePdfFromJpeg(targetFile, tmpPdf);
      const classification = classifyDocumentForFiling(ocrResult.text || '', 'doc-bw', description);
      const filename = await generateFilename(ocrResult.text || '', classification, description || '', 'pdf');
      const ncPath = classification.path || '/Inbox/';
      await nextcloudUpload(tmpPdf, ncPath, filename);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            source_file: path.basename(targetFile),
            filed_at: `${ncPath}${filename}`,
            filename,
            document_type: classification.type,
            pdf_method: pdfResult.method,
            word_count: ocrResult.word_count || 0,
            ocr_preview: (ocrResult.text || '').slice(0, 300).trim(),
          }),
        }],
      };
    } finally {
      try { fs.unlinkSync(tmpPdf); } catch (_) {}
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
