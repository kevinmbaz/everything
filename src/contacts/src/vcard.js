// vCard 3.0 import/export (pure). Round-trips the fields this app supports and
// interoperates with Google/Apple Contacts via standard TYPE parameters.
import { normalizeContact, displayName } from './model.js'
import { countryName, countryCodeFromName } from './countries.js'

// --- export -----------------------------------------------------------------

function escapeValue(value) {
  return String(value == null ? '' : value)
    // Normalize CR/CRLF to LF first — a raw CR would split the property line
    // on re-import and silently truncate the value.
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}

// Fold long lines per RFC 6350 (continuation lines begin with a single space).
// Never split inside a surrogate pair: a lone surrogate can't survive the
// file's UTF-8 encoding (it becomes U+FFFD), corrupting emoji and other
// astral characters that happen to straddle a fold boundary.
function foldWidth(s, max) {
  if (s.length <= max) return s.length
  let w = max
  const units = s.charCodeAt(w - 1)
  if (units >= 0xd800 && units <= 0xdbff) w -= 1 // high surrogate at the cut
  return w
}

function fold(line) {
  if (line.length <= 73) return line
  const chunks = []
  let rest = line
  let w = foldWidth(rest, 73)
  chunks.push(rest.slice(0, w))
  rest = rest.slice(w)
  while (rest.length > 72) {
    w = foldWidth(rest, 72)
    chunks.push(' ' + rest.slice(0, w))
    rest = rest.slice(w)
  }
  if (rest.length) chunks.push(' ' + rest)
  return chunks.join('\r\n')
}

const PHONE_TYPE_OUT = { Mobile: 'CELL', Home: 'HOME', Work: 'WORK', Main: 'MAIN', Other: 'OTHER' }
const EMAIL_TYPE_OUT = { Personal: 'HOME', Work: 'WORK', Other: 'OTHER' }
const ADDR_TYPE_OUT = { Home: 'HOME', Work: 'WORK', Other: 'OTHER' }

function typeParam(label, map) {
  const t = map[label] || String(label || '').toUpperCase().replace(/[^A-Z0-9-]/g, '')
  return t ? `;TYPE=${t}` : ''
}

/** Serialize a single contact to a vCard 3.0 string. */
export function contactToVCard(contact, { preserveIds = false } = {}) {
  const c = normalizeContact(contact)
  const lines = ['BEGIN:VCARD', 'VERSION:3.0']
  if (preserveIds) lines.push(`UID:${escapeValue(c.id)}`)

  lines.push(`N:${escapeValue(c.lastName)};${escapeValue(c.firstName)};;;`)
  lines.push(`FN:${escapeValue(displayName(c))}`)
  if (c.nickname) lines.push(`NICKNAME:${escapeValue(c.nickname)}`)
  if (c.company) lines.push(`ORG:${escapeValue(c.company)}`)
  if (c.jobTitle) lines.push(`TITLE:${escapeValue(c.jobTitle)}`)

  for (const e of c.emails) lines.push(`EMAIL${typeParam(e.label, EMAIL_TYPE_OUT)}:${escapeValue(e.value)}`)
  for (const p of c.phones) lines.push(`TEL${typeParam(p.label, PHONE_TYPE_OUT)}:${escapeValue(p.value)}`)
  for (const u of c.urls) lines.push(`URL${typeParam(u.label, {})}:${escapeValue(u.value)}`)
  // ADR components: PO box; extended (line 2); street; locality; region; postal code; country.
  for (const a of c.addresses) {
    const parts = [
      a.poBox, a.street2, a.street, a.city, a.state, a.postalCode, countryName(a.country),
    ].map(escapeValue)
    lines.push(`ADR${typeParam(a.label, ADDR_TYPE_OUT)}:${parts.join(';')}`)
  }

  if (c.birthday) lines.push(`BDAY:${escapeValue(c.birthday)}`)
  if (c.notes) lines.push(`NOTE:${escapeValue(c.notes)}`)
  if (c.tags.length) lines.push(`CATEGORIES:${c.tags.map((t) => escapeValue(t)).join(',')}`)

  if (c.photo) {
    const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(c.photo)
    if (m) lines.push(`PHOTO;ENCODING=b;TYPE=${m[1].toUpperCase()}:${m[2]}`)
    else if (/^https?:\/\//i.test(c.photo)) lines.push(`PHOTO;VALUE=uri:${escapeValue(c.photo)}`)
  }

  lines.push('END:VCARD')
  return lines.map(fold).join('\r\n')
}

/** Serialize many contacts into one .vcf document. */
export function contactsToVCard(contacts, options) {
  return contacts.map(c => contactToVCard(c, options)).join('\r\n') + '\r\n'
}

// --- import -----------------------------------------------------------------

function unescapeValue(value) {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\' && i + 1 < value.length) {
      const next = value[++i]
      if (next === 'n' || next === 'N') out += '\n'
      else out += next
    } else {
      out += ch
    }
  }
  return out
}

// Split a structured value on unescaped separators.
function splitUnescaped(value, sep) {
  const parts = []
  let cur = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\' && i + 1 < value.length) {
      cur += ch + value[++i]
    } else if (ch === sep) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  parts.push(cur)
  return parts
}

const PHONE_TYPE_IN = { CELL: 'Mobile', MOBILE: 'Mobile', HOME: 'Home', WORK: 'Work', MAIN: 'Main', FAX: 'Fax', OTHER: 'Other' }
const EMAIL_TYPE_IN = { HOME: 'Personal', WORK: 'Work', OTHER: 'Other' }
const ADDR_TYPE_IN = { HOME: 'Home', WORK: 'Work', OTHER: 'Other' }
const NOISE_TYPES = new Set(['PREF', 'VOICE', 'INTERNET', 'TYPE', 'QUOTED-PRINTABLE'])

function titleCase(token) {
  const t = String(token || '').toLowerCase()
  return t ? t[0].toUpperCase() + t.slice(1) : ''
}

// Pull TYPE tokens out of the raw param segments of a property line.
function typesFrom(params) {
  const types = []
  for (const p of params) {
    const [k, v] = p.includes('=') ? p.split('=') : ['TYPE', p]
    if (k.toUpperCase() === 'TYPE' && v) {
      for (const tok of v.split(',')) types.push(tok.trim().toUpperCase())
    }
  }
  return types.filter((t) => !NOISE_TYPES.has(t))
}

function labelFor(params, map, fallback) {
  for (const t of typesFrom(params)) {
    if (map[t]) return map[t]
  }
  const first = typesFrom(params)[0]
  return first ? titleCase(first) : fallback
}

// Normalize the wire formats other exporters use for BDAY into this app's
// YYYY-MM-DD (with 0000 marking a year-less birthday): RFC 6350's compact
// 19900415 and year-less --0415 forms, plus Apple's convention of pinning an
// omitted year to 1604 and flagging it with X-APPLE-OMIT-YEAR.
function normalizeBdayValue(value, params) {
  let s = String(value || '').trim()
  // Drop any time part (BDAY:19900415T120000 / 1990-04-15T12:00:00Z) so the
  // date-only patterns below can match instead of passing garbage through.
  s = s.replace(/[T ].*$/, '')
  let m
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) s = `${m[1]}-${m[2]}-${m[3]}`
  else if ((m = /^--(\d{2})-?(\d{2})$/.exec(s))) s = `0000-${m[1]}-${m[2]}`
  else s = s.slice(0, 10)
  if (params.some((p) => /^X-APPLE-OMIT-YEAR(=|$)/i.test(p))) s = s.replace(/^\d{4}/, '0000')
  return s
}

// vCard 2.1 (still what Android and old Outlook export) carries non-ASCII text
// as quoted-printable: UTF-8 octets written as =XX escapes. Decode a value's
// octet stream back to text; literal characters pass through as their own
// UTF-8 bytes so mixed content stays intact.
function isQuotedPrintable(params) {
  return params.some((p) => /^(ENCODING=)?QUOTED-PRINTABLE$/i.test(p.trim()))
}

let _qpEncoder
function decodeQuotedPrintable(value) {
  if (!_qpEncoder) _qpEncoder = new TextEncoder()
  const bytes = []
  for (let i = 0; i < value.length; i++) {
    const hex = value[i] === '=' ? value.slice(i + 1, i + 3) : ''
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16))
      i += 2
    } else {
      for (const b of _qpEncoder.encode(value[i])) bytes.push(b)
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

// Unfold folded lines (a leading space/tab continues the previous line).
function unfold(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
}

/** Parse a .vcf document into an array of normalized contacts. */
export function vCardToContacts(text, { preserveIds = false } = {}) {
  const lines = unfold(text).split('\n')
  const contacts = []
  let cur = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd()
    if (!line) continue
    const upper = line.toUpperCase()
    if (upper === 'BEGIN:VCARD') {
      cur = { emails: [], phones: [], urls: [], addresses: [], tags: [] }
      continue
    }
    if (upper === 'END:VCARD') {
      if (cur) {
        // If the card had only FN (no N), seed first/last from it before
        // normalizing, which would otherwise drop the temporary _fn field.
        if (!cur.firstName && !cur.lastName && cur._fn) {
          const parts = cur._fn.trim().split(/\s+/)
          cur.firstName = parts.shift() || ''
          cur.lastName = parts.join(' ')
        }
        delete cur._fn
        contacts.push(normalizeContact(cur))
      }
      cur = null
      continue
    }
    if (!cur) continue

    const colon = line.indexOf(':')
    if (colon === -1) continue
    const head = line.slice(0, colon)
    let value = line.slice(colon + 1)
    const segments = head.split(';')
    // Property name may carry a group prefix (e.g. "item1.EMAIL").
    const name = segments[0].split('.').pop().toUpperCase()
    const params = segments.slice(1)
    // Capture literal UID whitespace before advancing i through continuations.
    // Other fields retain their existing trim/display semantics.
    const literalUid = preserveIds && name === 'UID'
    if (literalUid) value = lines[i].slice(colon + 1)

    // Quoted-printable soft line breaks: a trailing '=' continues the value on
    // the next physical line (vCard 2.1 folding — no leading space, so the
    // standard unfold above didn't join it).
    const qp = isQuotedPrintable(params)
    while (qp && value.endsWith('=') && i + 1 < lines.length) {
      const continuation = lines[++i]
      value = value.slice(0, -1) + (literalUid ? continuation : continuation.trimEnd())
    }
    // Decode after splitting on separators (an encoded =3B is a literal ';',
    // not a component separator), so each component decodes on its own.
    const uv = qp ? (s) => unescapeValue(decodeQuotedPrintable(s)) : unescapeValue

    switch (name) {
      case 'UID': {
        if (!preserveIds) break
        // Unlike display fields, UID bytes are identifiers, not trim-able text.
        const id = uv(value)
        if (!id || [...id].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) || Object.hasOwn(cur, 'id')) throw new Error('Invalid or duplicate vCard UID')
        cur.id = id
        break
      }
      case 'N': {
        const comps = splitUnescaped(value, ';').map(uv)
        cur.lastName = comps[0] || ''
        cur.firstName = comps[1] || ''
        break
      }
      case 'FN':
        cur._fn = uv(value)
        break
      case 'NICKNAME':
        cur.nickname = uv(value)
        break
      case 'ORG':
        cur.company = splitUnescaped(value, ';').map(uv).filter(Boolean).join(' · ')
        break
      case 'TITLE':
        cur.jobTitle = uv(value)
        break
      case 'EMAIL':
        cur.emails.push({ label: labelFor(params, EMAIL_TYPE_IN, 'Personal'), value: uv(value) })
        break
      case 'TEL':
        cur.phones.push({ label: labelFor(params, PHONE_TYPE_IN, 'Mobile'), value: uv(value) })
        break
      case 'URL':
        cur.urls.push({ label: labelFor(params, {}, 'Website'), value: uv(value) })
        break
      case 'ADR': {
        const comps = splitUnescaped(value, ';').map(uv)
        const addr = {
          label: labelFor(params, ADDR_TYPE_IN, 'Home'),
          poBox: comps[0] || '',
          street2: comps[1] || '',
          street: comps[2] || '',
          city: comps[3] || '',
          state: comps[4] || '',
          postalCode: comps[5] || '',
          country: comps[6] ? countryCodeFromName(comps[6]) : '',
        }
        if (addr.street || addr.street2 || addr.city || addr.state || addr.postalCode || addr.poBox) {
          cur.addresses.push(addr)
        }
        break
      }
      case 'BDAY':
        cur.birthday = normalizeBdayValue(uv(value), params)
        break
      case 'NOTE':
        cur.notes = uv(value)
        break
      case 'CATEGORIES':
        cur.tags = splitUnescaped(value, ',').map(uv).map((t) => t.trim()).filter(Boolean)
        break
      case 'PHOTO': {
        const paramStr = params.join(';').toUpperCase()
        const v = value.trim()
        // Only take photo values a contact photo can legitimately be: an
        // inline image data URI or an http(s) URL. Anything else a crafted
        // file might carry (data:text/html, javascript:, ftp:, …) is dropped
        // rather than stored and re-rendered.
        if (/^data:image\//i.test(v)) {
          cur.photo = v
        } else if (/^https?:\/\//i.test(v)) {
          // Export escapes the URL like any other value (a comma becomes
          // "\,"), so undo that here or the stored URL no longer resolves.
          cur.photo = uv(v)
        } else if (/ENCODING=(B|BASE64)/.test(paramStr)) {
          const typeMatch = /TYPE=([A-Z0-9.+-]+)/.exec(paramStr)
          let imgType = (typeMatch ? typeMatch[1] : 'JPEG').toLowerCase()
          if (imgType === 'jpg') imgType = 'jpeg'
          cur.photo = `data:image/${imgType};base64,${v.replace(/\s+/g, '')}`
        }
        break
      }
      default:
        break
    }
  }

  return contacts
}
