// Synthetic SPL documents for tests. All text in them is invented here; no real label text is used.

export type SplHeader = {
  documentId: string
  setId: string
  version: number
  effectiveTime?: string
  typeCode?: string
}

export function splDocument(header: SplHeader, body = SIMPLE_BODY, prolog = ''): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    prolog,
    '<document xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<id root="${header.documentId}"/>`,
    `<code code="${header.typeCode ?? '34391-3'}" codeSystem="2.16.840.1.113883.6.1"/>`,
    '<title>Synthetic test label</title>',
    `<effectiveTime value="${header.effectiveTime ?? '20240102'}"/>`,
    `<setId root="${header.setId}"/>`,
    `<versionNumber value="${header.version}"/>`,
    '<component><structuredBody>',
    body,
    '</structuredBody></component>',
    '</document>',
    '',
  ].join('\n')
}

export const SIMPLE_BODY =
  '<component><section><code code="34067-9"/><title>1 PURPOSE</title>' +
  '<text><paragraph>Invented test text for a synthetic label.</paragraph></text></section></component>'
