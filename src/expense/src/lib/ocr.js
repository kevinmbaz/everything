/**
 * Receipt OCR through Puter AI. The vision model gets the image and a strict
 * JSON contract; the response is parsed defensively because models wrap
 * JSON in prose or code fences. Falls back to plain img2txt plus a text
 * extraction pass when the vision call fails.
 */

import { parseLooseDate, todayISO } from './dates.js';
import { parseAmount } from './money.js';
import { resolveCurrency } from './currencies.js';
import { normalizeText, tokens } from './util.js';

export const DEFAULT_OCR_MODEL = 'gpt-5.6-luna';
export const PAYMENT_METHODS = ['Card', 'Cash', 'Bank transfer', 'Mobile payment', 'Other'];

export function buildOcrPrompt({ categories = [], baseCurrency = 'USD' } = {}) {
  const cats = categories.map((c) => c.name).join(', ') || 'Other';
  return [
    'You are an expense-receipt reader. Extract the fields below from the receipt image.',
    'Respond with ONLY a JSON object, no prose, no code fences, using exactly these keys:',
    '{',
    '  "merchant": string | null,            // business name as printed',
    '  "date": "YYYY-MM-DD" | null,           // purchase date',
    '  "total": number | null,                // grand total paid, including tax and tip',
    '  "tax": number | null,                  // total tax if shown',
    '  "tip": number | null,                  // tip or gratuity if shown',
    `  "currency": string | null,             // ISO 4217 code; infer from symbols; default "${baseCurrency}" if unclear`,
    `  "category": string | null,             // one of: ${cats}`,
    '  "paymentMethod": string | null,        // one of: Card, Cash, Bank transfer, Mobile payment, Other',
    '  "cardLast4": string | null,            // last four digits if printed',
    '  "items": [{ "name": string, "amount": number }],   // line items, at most 25',
    '  "notes": string | null,                // anything notable, e.g. "2 guests", or null',
    '  "confidence": number                   // 0 to 1, your confidence in merchant, date and total',
    '}',
    'Use null for anything not visible. Numbers must be plain decimals without symbols.',
  ].join('\n');
}

/** Pull the first balanced JSON object out of free text. */
export function extractJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i += 1;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Find the category whose name best matches a free-text label. */
export function matchCategory(label, categories = []) {
  if (!label || !categories.length) return null;
  const want = normalizeText(label);
  if (!want) return null;
  let exact = categories.find((c) => normalizeText(c.name) === want);
  if (exact) return exact;
  const wantTokens = new Set(tokens(label));
  let best = null;
  let bestScore = 0;
  for (const c of categories) {
    const ct = tokens(c.name);
    const hit = ct.filter((t) => wantTokens.has(t) || [...wantTokens].some((w) => w.startsWith(t) || t.startsWith(w))).length;
    const score = hit / Math.max(1, ct.length);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 0.5 ? best : null;
}

/**
 * Normalise whatever the model returned into the shape the expense form
 * expects. Never throws; missing pieces come back null so the user fills
 * them in.
 */
export function normalizeOcrResult(raw, { categories = [], baseCurrency = 'USD', now = new Date() } = {}) {
  const data = extractJson(raw) || {};
  const total = parseAmount(data.total ?? data.amount ?? data.grand_total);
  let date = parseLooseDate(data.date, { now });
  // A receipt cannot be from the future; a wrongly parsed year is more likely.
  if (date && date > todayISO(now)) date = null;
  const currency = resolveCurrency(data.currency, null) || baseCurrency;
  const category = matchCategory(data.category, categories);
  const items = Array.isArray(data.items)
    ? data.items
      .map((it) => ({ name: String(it?.name ?? it?.description ?? '').trim(), amount: parseAmount(it?.amount ?? it?.price) }))
      .filter((it) => it.name)
      .slice(0, 25)
    : [];
  const method = PAYMENT_METHODS.find((m) => normalizeText(m) === normalizeText(data.paymentMethod))
    || (data.paymentMethod && /card|visa|master|amex|debit|credit/i.test(String(data.paymentMethod)) ? 'Card' : null);
  let confidence = Number(data.confidence);
  if (!Number.isFinite(confidence)) confidence = total !== null && date ? 0.6 : 0.3;
  confidence = Math.min(1, Math.max(0, confidence));
  return {
    merchant: data.merchant ? String(data.merchant).trim().slice(0, 120) : null,
    date,
    total: total !== null && total >= 0 ? total : null,
    tax: parseAmount(data.tax),
    tip: parseAmount(data.tip),
    currency,
    categoryId: category?.id || null,
    paymentMethod: method,
    cardLast4: data.cardLast4 ? String(data.cardLast4).replace(/\D/g, '').slice(-4) || null : null,
    items,
    notes: data.notes ? String(data.notes).trim().slice(0, 300) : null,
    confidence,
  };
}

function messageText(res) {
  if (!res) return '';
  if (typeof res === 'string') return res;
  const content = res.message?.content ?? res.content ?? res.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text || '').join('\n');
  return '';
}

/**
 * Run OCR on a receipt image. `sdk` is the puter object (injected for tests).
 * Resolves to { result, source, rawText } where source is 'vision' or 'ocr'.
 */
export async function runReceiptOcr(file, { categories, baseCurrency, model = DEFAULT_OCR_MODEL, sdk = globalThis.puter, now = new Date() } = {}) {
  if (import.meta.env.VITE_PRIVATE_STORAGE === '1' || sdk?.mode === 'private') throw new Error('Cloud OCR is unavailable in private mode. Enter receipt fields manually.');
  const prompt = buildOcrPrompt({ categories, baseCurrency });
  let lastError = null;
  try {
    const res = await sdk.ai.chat(prompt, file, { model, temperature: 0 });
    const text = messageText(res);
    const json = extractJson(text);
    if (json) return { result: normalizeOcrResult(json, { categories, baseCurrency, now }), source: 'vision', rawText: text };
    lastError = new Error('The model did not return structured data');
  } catch (err) {
    lastError = err;
  }

  // Fallback: plain OCR text, then a cheap text-only extraction.
  try {
    const text = await sdk.ai.img2txt(file);
    if (text && text.trim()) {
      const res = await sdk.ai.chat(`${prompt}\n\nHere is the OCR text of the receipt:\n\n${text.slice(0, 6000)}`);
      const json = extractJson(messageText(res));
      const result = normalizeOcrResult(json || {}, { categories, baseCurrency, now });
      if (!json) result.notes = result.notes || 'Read from OCR text; please check the fields';
      return { result, source: 'ocr', rawText: text };
    }
  } catch (err) {
    lastError = err;
  }
  const e = new Error(errorMessage(lastError));
  e.cause = lastError;
  throw e;
}

function errorMessage(err) {
  const msg = err?.message || err?.error?.message || (typeof err === 'string' ? err : '');
  if (/insufficient|credit|quota|limit/i.test(msg)) return 'AI usage limit reached. Add the expense manually, or try again later.';
  if (/network|fetch|offline/i.test(msg)) return 'Couldn’t reach the AI service. Check your connection.';
  return msg ? `Couldn’t read the receipt: ${msg}` : 'Couldn’t read the receipt.';
}
