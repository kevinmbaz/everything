import { it, expect } from 'vitest'
import { contactToVCard, vCardToContacts } from './vcard.js'
import { normalizeContact } from './model.js'

it('private vCard export/import preserves a supplied literal UID and avatar without changing default export', () => {
  const c = normalizeContact({ id: ' literal:id:01 ', firstName: 'Ada', photo: 'data:image/png;base64,YQ==' })
  const text = contactToVCard(c, { preserveIds: true })
  expect(text).toContain('UID: literal:id:01 ')
  expect(vCardToContacts(text, { preserveIds: true })[0]).toMatchObject({ id: c.id, firstName: c.firstName, photo: c.photo })
  expect(contactToVCard(c)).not.toContain('UID:')
})
it.each([
  ['long continuation', 'prefix=\n0123456789012345678901234567890123456789', 'prefix0123456789012345678901234567890123456789'],
  ['short continuation', 'prefix=\nx', 'prefixx'],
  ['multiple continuations', 'first=\nsecond=\nthird', 'firstsecondthird'],
  ['literal spaces and escapes', '  =C3=A9\\,=\npart\\;=\nend=5C=5C  ', '  é,part;end\\  '],
])('preserves the complete private quoted-printable UID: %s', (_label, value, expected) => {
  const text = `BEGIN:VCARD\nVERSION:2.1\nFN:Test\nUID;ENCODING=QUOTED-PRINTABLE:${value}\nEND:VCARD`
  expect(vCardToContacts(text, { preserveIds: true })[0].id).toBe(expected)
})

it('keeps default UID ignoring and display-field quoted-printable decoding unchanged', () => {
  const text = 'BEGIN:VCARD\nVERSION:2.1\nFN;ENCODING=QUOTED-PRINTABLE:First=\n=20Person\nUID;ENCODING=QUOTED-PRINTABLE:prefix=\nx\nEND:VCARD'
  const c = vCardToContacts(text)[0]
  expect(c.id).not.toBe('prefixx')
  expect(c).toMatchObject({ firstName: 'First', lastName: 'Person' })
})

it('private vCard import rejects blank, duplicate or control-character UIDs instead of repairing identifiers', () => {
  for (const uid of ['', 'one\u0001', 'one\nUID:two']) {
    expect(() => vCardToContacts(`BEGIN:VCARD\nVERSION:3.0\nFN:A\nUID:${uid}\nEND:VCARD`, { preserveIds: true })).toThrow(/UID/)
  }
})
