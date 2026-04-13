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
        "Scan a document from the HP OfficeJet 5740 using scanimage. Uses SCANNER_DEVICE env var (default escl:http://192.168.1.183:8080). Returns success, path, resolution, mode, and source on success.",
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
    } = args;

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
        `scanimage --device-name=${JSON.stringify(SCANNER_DEVICE)} --format=${format} --output-file=${JSON.stringify(output_path)} --resolution=${resolution} --mode=${JSON.stringify(mode)} --source=${JSON.stringify(source)}`
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

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
