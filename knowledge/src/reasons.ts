// The closed set of reasons a label is not pinned or not fetched. Only these codes are ever written to a
// file: a parser's own message can quote the document, and no label text may reach a tracked file.

export const REASONS = [
  // The benchmark's record has a set id that is not a lowercase GUID (some records have an empty one).
  'set-id-not-a-guid',
  // A second benchmark record with a set id already seen.
  'duplicate-set-id',
  // DailyMed's history for the set id lists no version.
  'no-history',
  // DailyMed answers 404 for the version's file.
  'version-not-served',
  // The download is larger than its cap.
  'zip-too-large',
  // The download is not a readable zip (for example, truncated).
  'zip-unreadable',
  // The zip has no member ending in .xml.
  'zip-no-xml-member',
  // The zip has more than one member ending in .xml.
  'zip-several-xml-members',
  // The XML member produced more bytes than its cap, or declares more.
  'xml-too-large',
  // The XML is not valid UTF-8, or declares an encoding other than UTF-8.
  'xml-not-utf8',
  // The XML parser reported an error.
  'xml-not-well-formed',
  // The XML has a DOCTYPE whose internal subset declares an entity.
  'xml-doctype-declares-entities',
  // The root element is not an SPL document, or its id, set id, version, effective time or type is missing.
  'xml-not-spl',
  // The XML's set id or version is not the one asked for.
  'xml-identity-mismatch',
  // The XML's SHA-256 differs from the manifest.
  'xml-checksum-mismatch',
  // A benchmark file's SHA-256 differs from the pin.
  'benchmark-checksum-mismatch',
  // The request failed after every attempt (no response, or 408, 429 or 5xx each time), or got another status.
  'download-failed',
] as const

export type Reason = (typeof REASONS)[number]

// A refusal of one label or file, carrying only a code.
export class Refusal extends Error {
  readonly reason: Reason

  constructor(reason: Reason) {
    super(reason)
    this.name = 'Refusal'
    this.reason = reason
  }
}
