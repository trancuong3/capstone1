import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REFERENCE_LOCALE = "vi";
const EXPECTED_NAMESPACES = [
  "common",
  "auth",
  "navigation",
  "parent",
  "child",
  "admin",
  "books",
  "ocr",
  "reading",
  "speech",
  "difficultWords",
  "reports",
  "entertainment",
  "games",
  "settings",
  "errors",
  "validation",
  "notifications",
  "accessibility",
];

const UNTRANSLATED_ALLOWLIST = new Set([
  "ViRead",
  "ViRead Studio",
  "ViRead Android WebView",
  "Android WebView",
  "iOS WebView",
  "OCR",
  "Hybrid OCR",
  "VietOCR",
  "VietOCR V2 Fine-Tuned",
  "PaddleOCR",
  "Tesseract",
  "AI Tutor",
  "Supabase",
  "Google Drive",
  "Google Drive for Desktop",
  "Apps Script Bridge",
  "#",
  "WebAssembly SIMD",
  "IndexedDB",
  "WASM",
  "HTTPS",
  "HTTP",
  "APK",
  "PDF",
  "DOCX",
  "PNG",
  "JPEG",
  "JPG",
  "WebP",
  "Email",
  "ADMIN",
  "Admin",
  "Google",
  "Facebook",
  "Android",
  "Offline",
  "Online",
  "Queued",
  "Client Device Capabilities",
  "TTS",
  "STT",
  "JSON",
  "YAML",
  "CER",
  "WER",
  "SGK",
  "ISBN",
  "URL",
  "API",
  "WebSocket",
  "PIN",
  "OTP",
  "Karaoke",
  "MP3",
  "WAV",
  "px",
  "ms",
  "KB",
  "MB",
  "B",
  "vi-VN",
  "GRADE_1_TO_5",
  "CandidateHash",
  "SafetyInputHash",
  "FinalApprovedTextHash",
  "config.yml",
  "minhanh@example.com",
  "name@example.com",
  "https://script.google.com/macros/s/.../exec",
  "0905373633",
  "vireadforyou@gmail.com",
]);

/**
 * Technical/English strings that already appear verbatim in English inside
 * `messages/vi/*.json`. Kept verbatim in `en`, and also acceptable as
 * technical labels in locales where engineering terms remain in English.
 */
const ENGLISH_REFERENCE_TERMS = new Set([
  "Model STT (IndexedDB)",
  "Metadata",
  "AI Safety",
  "Proofreading",
  "Proofreading: {proofreading}",
  "30s",
  "60s",
  "Child Safety",
  "Findings",
  "Assessment hash",
  "Category false positive",
  "Safety stale",
  "Workflow {workflowId} · Revision {revisionId}",
  "Hash: {hash}",
  "Rule:",
  "AI:",
  "Admin OCR Diagnostics · runtime checkpoint",
  "Fallback",
  "VietOCR package",
  "Child Safety · GRADE_1_TO_5",
  "Overall suitability",
  "Candidate version",
  "Safety hash match",
  "Safety findings",
  "Run {runId} · Prompt {promptVersion} · {duration} ms · Safety prompt {safetyPrompt}",
  " · fallback {count}",
  "Candidate hash",
  "Safety input hash",
  "Admin confirm",
  "{status} · {suitability} · {count} finding",
  " · hash {hash}…",
  " · Safety prompt ",
  "Not provided",
  "Not processed",
  " · not probability",
  "OCR source token: {value}",
  "Alignment: {value}",
  "Reference text:",
  "Calibrated accuracy:",
  "Bounding box quality:",
  "Crop quality:",
  "Crop PaddleOCR:",
  "Crop VietOCR:",
  "Crop Tesseract:",
  "Paddle crop raw recognition score:",
  "VietOCR crop raw recognition score:",
  "Crop status:",
  "VietOCR decoding mode:",
  "Crop contrast (standard deviation):",
  "Ink ratio:",
  "Padding clipped by page boundary:",
  "Not recorded",
  "Not computed",
  "None",
  "Not selected",
  "Not assessed",
  "No crop candidate recorded",
  "Not run or no candidate",
  "Not applicable",
  "Yes",
  "No",
  "Evidence supports a likely-correct OCR token; not Admin verified",
  "Insufficient OCR evidence; Admin review required",
  "Confidence",
  "Confidence:",
  "Supabase Legacy",
  "Desired Active Model (Database Pointer)",
  "Train {train} · Validation {validation} · Holdout {holdout}",
  " · Legacy Supabase: ",
  "{type} benchmark-only · {status}",
  "Job {jobId} · manifest {manifest}",
  "Execution {id}",
  "Run {id}",
  "Checkpoint",
  "Pilot Evaluation",
  "Production Evaluation",
  "Evaluation",
  "Benchmark:",
  " · Benchmark: ",
  "Baseline ({name})",
  "Baseline",
  "Model Only",
  "Full Pipe",
  "Fine-tuned (Model Only)",
  "Fine-tuned (Full Pipeline)",
  "Exact Match",
  "Exact Match (%)",
  "Word F1",
  "F1-Score (%)",
  "Revision {revision} · {state}",
  "camera",
  "microphone",
  "email",
  "job",
]);

const VIETNAMESE_DIACRITIC_PATTERN =
  /[\u0102\u0103\u0110\u0111\u01A0\u01A1\u01AF\u01B0\u1EA0-\u1EF9]/;

/**
 * Finds duplicate JSON object keys at any nesting level from raw JSON text
 * before `JSON.parse()` silently collapses duplicates.
 */
export function findDuplicateJsonKeys(rawJson, filePath = "<json>") {
  const duplicates = [];
  let index = 0;
  const length = rawJson.length;

  function skipWhitespace() {
    while (index < length && /\s/.test(rawJson[index])) {
      index += 1;
    }
  }

  function parseString() {
    index += 1;
    let result = "";
    while (index < length) {
      const ch = rawJson[index];
      if (ch === "\\") {
        const next = rawJson[index + 1] ?? "";
        result += ch + next;
        index += 2;
        continue;
      }
      if (ch === '"') {
        index += 1;
        return result;
      }
      result += ch;
      index += 1;
    }
    throw new SyntaxError(`Unterminated string in ${filePath}`);
  }

  function parseValue(currentPath) {
    skipWhitespace();
    if (index >= length) return;
    const ch = rawJson[index];
    if (ch === "{") {
      parseObject(currentPath);
    } else if (ch === "[") {
      parseArray(currentPath);
    } else if (ch === '"') {
      parseString();
    } else {
      while (index < length && !/[\s,}\]]/.test(rawJson[index])) {
        index += 1;
      }
    }
  }

  function parseArray(currentPath) {
    index += 1;
    skipWhitespace();
    if (rawJson[index] === "]") {
      index += 1;
      return;
    }
    let itemIdx = 0;
    while (index < length) {
      parseValue(`${currentPath}[${itemIdx}]`);
      itemIdx += 1;
      skipWhitespace();
      if (rawJson[index] === ",") {
        index += 1;
        continue;
      }
      if (rawJson[index] === "]") {
        index += 1;
        return;
      }
      break;
    }
  }

  function parseObject(currentPath) {
    index += 1;
    const seen = new Set();
    skipWhitespace();
    if (rawJson[index] === "}") {
      index += 1;
      return;
    }
    while (index < length) {
      skipWhitespace();
      if (rawJson[index] !== '"') break;
      const key = parseString();
      const keyPath = currentPath ? `${currentPath}.${key}` : key;
      if (seen.has(key)) {
        duplicates.push(keyPath);
      } else {
        seen.add(key);
      }
      skipWhitespace();
      if (rawJson[index] !== ":") break;
      index += 1;
      parseValue(keyPath);
      skipWhitespace();
      if (rawJson[index] === ",") {
        index += 1;
        continue;
      }
      if (rawJson[index] === "}") {
        index += 1;
        return;
      }
      break;
    }
  }

  parseValue("");
  return duplicates;
}

export function flattenMessages(obj, prefix = "", output = new Map()) {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return output;
  }
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      output.set(fullKey, value);
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      flattenMessages(value, fullKey, output);
    }
  }
  return output;
}

export function hasBalancedBraces(template) {
  let depth = 0;
  for (let i = 0; i < template.length; i += 1) {
    const ch = template[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function findMatchingBrace(input, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < input.length; i += 1) {
    if (input[i] === "{") depth += 1;
    else if (input[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function extractPlaceholders(template) {
  const placeholders = new Set();
  let hasPlural = false;
  let hasOtherBranch = true;

  function scan(segment) {
    let i = 0;
    while (i < segment.length) {
      if (segment[i] !== "{") {
        i += 1;
        continue;
      }
      const close = findMatchingBrace(segment, i);
      if (close === -1) break;
      const inner = segment.slice(i + 1, close);
      const firstComma = inner.indexOf(",");
      if (firstComma === -1) {
        const name = inner.trim();
        if (name) placeholders.add(name);
      } else {
        const name = inner.slice(0, firstComma).trim();
        if (name) placeholders.add(name);
        const rest = inner.slice(firstComma + 1);
        const secondComma = rest.indexOf(",");
        const kind =
          secondComma === -1 ? rest.trim() : rest.slice(0, secondComma).trim();
        if (kind === "plural" && secondComma !== -1) {
          hasPlural = true;
          const branchesText = rest.slice(secondComma + 1);
          if (!/\bother\s*\{/.test(branchesText)) {
            hasOtherBranch = false;
          }
          let j = 0;
          while (j < branchesText.length) {
            if (branchesText[j] === "{") {
              const branchClose = findMatchingBrace(branchesText, j);
              if (branchClose === -1) break;
              scan(branchesText.slice(j + 1, branchClose));
              j = branchClose + 1;
            } else {
              j += 1;
            }
          }
        }
      }
      i = close + 1;
    }
  }

  scan(template);
  return {
    placeholders: Array.from(placeholders).sort(),
    hasPlural,
    hasOtherBranch,
  };
}

function isAllowlistedUntranslated(value, locale, refValue) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (UNTRANSLATED_ALLOWLIST.has(trimmed)) return true;
  if (
    ENGLISH_REFERENCE_TERMS.has(refValue) &&
    (locale === "en" ||
      trimmed === refValue.trim() ||
      ENGLISH_REFERENCE_TERMS.has(trimmed))
  ) {
    return true;
  }

  let remaining = trimmed.replace(/\{[^}]+\}/g, " ").trim();
  if (!remaining) return true;

  for (const allowed of UNTRANSLATED_ALLOWLIST) {
    remaining = remaining.split(allowed).join(" ").trim();
  }

  remaining = remaining
    .replace(/[©®™✓×↔•·↓↑→←“”‘’%.,:;!?—–\-/()[\]"'…\d\s]+/g, " ")
    .trim();

  return remaining.length === 0;
}

export function runI18nAudit(options) {
  const referenceLocale = options.referenceLocale ?? DEFAULT_REFERENCE_LOCALE;
  const messagesDir = options.messagesDir;

  const errors = [];
  const warnings = [];
  const localeSummaries = [];

  if (!fs.existsSync(messagesDir)) {
    errors.push(`Messages directory not found: ${messagesDir}`);
    return { ok: false, errors, warnings, localeSummaries };
  }

  const localeDirs = fs
    .readdirSync(messagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (!localeDirs.includes(referenceLocale)) {
    errors.push(`Reference locale directory missing: ${referenceLocale}`);
    return { ok: false, errors, warnings, localeSummaries };
  }

  function loadLocale(locale) {
    const dir = path.join(messagesDir, locale);
    const jsonFiles = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();

    const keys = new Map();
    const namespaces = new Set();

    for (const fileName of jsonFiles) {
      const ns = fileName.slice(0, -".json".length);
      namespaces.add(ns);
      const fullPath = path.join(dir, fileName);
      const raw = fs.readFileSync(fullPath, "utf8");

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        errors.push(`[${locale}/${fileName}] Invalid JSON: ${err.message}`);
        continue;
      }

      try {
        const dupes = findDuplicateJsonKeys(raw, `${locale}/${fileName}`);
        for (const dupe of dupes) {
          errors.push(`[${locale}/${fileName}] Duplicate key: ${dupe}`);
        }
      } catch (err) {
        errors.push(
          `[${locale}/${fileName}] Duplicate key scan failed: ${err.message}`,
        );
      }

      const flattened = flattenMessages(parsed, ns);
      for (const [k, v] of flattened.entries()) {
        keys.set(k, v);
      }
    }

    return { namespaces, keys };
  }

  const refBundle = loadLocale(referenceLocale);

  for (const expectedNs of EXPECTED_NAMESPACES) {
    if (!refBundle.namespaces.has(expectedNs)) {
      errors.push(
        `[${referenceLocale}] Missing required namespace file: ${expectedNs}.json`,
      );
    }
  }

  for (const [key, value] of refBundle.keys.entries()) {
    if (!value.trim()) {
      errors.push(`[${referenceLocale}] Empty string for key: ${key}`);
    }
    if (!hasBalancedBraces(value)) {
      errors.push(`[${referenceLocale}] Unbalanced braces in key: ${key}`);
    }
    const meta = extractPlaceholders(value);
    if (meta.hasPlural && !meta.hasOtherBranch) {
      errors.push(
        `[${referenceLocale}] Plural message missing "other" branch: ${key}`,
      );
    }
  }

  for (const locale of localeDirs) {
    const bundle = locale === referenceLocale ? refBundle : loadLocale(locale);
    let missingCount = 0;
    let extraCount = 0;
    let placeholderErrors = 0;
    let untranslatedCount = 0;
    let translatedCount = 0;

    for (const expectedNs of EXPECTED_NAMESPACES) {
      if (!bundle.namespaces.has(expectedNs)) {
        errors.push(`[${locale}] Missing namespace file: ${expectedNs}.json`);
      }
    }

    for (const [key, refVal] of refBundle.keys.entries()) {
      const targetVal = bundle.keys.get(key);
      if (targetVal === undefined) {
        missingCount += 1;
        errors.push(`[${locale}] Missing key: ${key}`);
        continue;
      }
      if (!targetVal.trim()) {
        missingCount += 1;
        errors.push(`[${locale}] Empty translation for key: ${key}`);
        continue;
      }

      if (!hasBalancedBraces(targetVal)) {
        placeholderErrors += 1;
        errors.push(`[${locale}] Unbalanced braces in key: ${key}`);
      }

      const refMeta = extractPlaceholders(refVal);
      const targetMeta = extractPlaceholders(targetVal);

      if (
        JSON.stringify(refMeta.placeholders) !==
        JSON.stringify(targetMeta.placeholders)
      ) {
        placeholderErrors += 1;
        errors.push(
          `[${locale}] Placeholder mismatch at ${key}: expected [${refMeta.placeholders.join(", ")}], got [${targetMeta.placeholders.join(", ")}]`,
        );
      }

      if (
        refMeta.hasPlural &&
        (!targetMeta.hasPlural || !targetMeta.hasOtherBranch)
      ) {
        placeholderErrors += 1;
        errors.push(
          `[${locale}] Plural structure mismatch at ${key}: missing plural or "other" branch`,
        );
      }

      if (locale !== referenceLocale) {
        const looksUntranslated =
          !isAllowlistedUntranslated(targetVal, locale, refVal) &&
          (targetVal.trim() === refVal.trim() ||
            VIETNAMESE_DIACRITIC_PATTERN.test(targetVal.normalize("NFC")));
        if (looksUntranslated) {
          untranslatedCount += 1;
          const message = `[${locale}] Potentially untranslated value at ${key}`;
          if (options.strict) {
            errors.push(message);
          } else {
            warnings.push(message);
          }
        } else {
          translatedCount += 1;
        }
      } else {
        translatedCount += 1;
      }
    }

    for (const key of bundle.keys.keys()) {
      if (!refBundle.keys.has(key)) {
        extraCount += 1;
        errors.push(`[${locale}] Extra key not in ${referenceLocale}: ${key}`);
      }
    }

    const totalKeys = refBundle.keys.size;
    const coveragePct =
      totalKeys > 0
        ? Number(((translatedCount / totalKeys) * 100).toFixed(2))
        : 100;

    localeSummaries.push({
      locale,
      totalKeys,
      translatedCount,
      missingCount,
      extraCount,
      placeholderErrors,
      untranslatedCount,
      coveragePct,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    localeSummaries,
  };
}

function main() {
  const args = process.argv.slice(2);
  const shouldWriteReport = args.includes("--report");
  const strict = args.includes("--strict");
  const outFlagIndex = args.indexOf("--out");
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendRoot = path.resolve(scriptDir, "..");
  const messagesDir = path.join(frontendRoot, "messages");
  const reportPath =
    outFlagIndex !== -1 && args[outFlagIndex + 1]
      ? path.resolve(frontendRoot, args[outFlagIndex + 1])
      : path.join(frontendRoot, "coverage", "i18n-report.json");

  const result = runI18nAudit({ messagesDir, strict });

  if (shouldWriteReport) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          referenceLocale: DEFAULT_REFERENCE_LOCALE,
          ok: result.ok,
          errorCount: result.errors.length,
          warningCount: result.warnings.length,
          locales: result.localeSummaries,
          errors: result.errors,
          warnings: result.warnings,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`i18n coverage report written to ${reportPath}`);
  }

  for (const summary of result.localeSummaries) {
    console.log(
      `[i18n] ${summary.locale}: ${summary.translatedCount}/${summary.totalKeys} (${summary.coveragePct}%), missing=${summary.missingCount}, extra=${summary.extraCount}, placeholders=${summary.placeholderErrors}, untranslated=${summary.untranslatedCount}`,
    );
  }

  for (const warning of result.warnings) {
    console.warn(`WARN: ${warning}`);
  }

  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`ERROR: ${error}`);
    }
    process.exitCode = 1;
  }
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main();
}
