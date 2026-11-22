// Reads a label's SPL XML safely, and the identity written inside it.
//
// The reader is @xmldom/xmldom. It performs no input or output of its own: it loads no DTD, resolves no
// external entity and fetches no stylesheet (a stylesheet instruction is kept as a node and ignored). It does
// not expand entities declared in a DOCTYPE either; a label whose DOCTYPE declares any is refused outright.
// The DOM it builds keeps mixed content (text between and around inline elements) in document order.

import { DOMParser } from '@xmldom/xmldom'
import type { Document, Element, Node } from '@xmldom/xmldom'

import { Refusal } from './reasons.ts'

export const SPL_NAMESPACE = 'urn:hl7-org:v3'

const TEXT_NODE = 3
const CDATA_SECTION_NODE = 4

// Parses the bytes of a label. Throws a Refusal, carrying only a code, for anything it will not read.
export function parseLabel(bytes: Buffer): Document {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Refusal('xml-not-utf8')
  }
  const declared = /^﻿?<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/.exec(text)
  if (declared?.[1] !== undefined && declared[1].toLowerCase() !== 'utf-8') throw new Refusal('xml-not-utf8')

  // Errors are collected, not thrown from inside the parser, so the DOCTYPE is judged first: a reference to a
  // declared entity is also an error ("entity not found"), and the refusal must name the declaration.
  let errors = 0
  let document: Document
  try {
    document = new DOMParser({
      onError: (level) => {
        if (level === 'warning') return
        errors++
        if (level === 'fatalError') throw new Refusal('xml-not-well-formed')
      },
    }).parseFromString(text, 'text/xml')
  } catch (error) {
    if (error instanceof Refusal) throw error
    throw new Refusal('xml-not-well-formed')
  }
  const subset = document.doctype?.internalSubset ?? ''
  if (/<!ENTITY/.test(subset)) throw new Refusal('xml-doctype-declares-entities')
  if (errors > 0) throw new Refusal('xml-not-well-formed')
  const root = document.documentElement
  if (!root || root.namespaceURI !== SPL_NAMESPACE || root.localName !== 'document') throw new Refusal('xml-not-spl')
  return document
}

export type LabelIdentity = {
  documentId: string
  setId: string
  version: number
  effectiveTime: string
  documentTypeCode: string
}

export function children(element: Element, localName: string): Element[] {
  const out: Element[] = []
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (isElement(node) && node.namespaceURI === SPL_NAMESPACE && node.localName === localName) out.push(node)
  }
  return out
}

export const isElement = (node: Node): node is Element => node.nodeType === 1

function childAttribute(root: Element, child: string, attribute: string): string | undefined {
  const [element] = children(root, child)
  const value = element?.getAttribute(attribute)
  return value === null || value === undefined || value === '' ? undefined : value
}

// The identity written in the document's header. Throws Refusal('xml-not-spl') if any part is missing.
export function readIdentity(document: Document): LabelIdentity {
  const root = document.documentElement
  if (!root) throw new Refusal('xml-not-spl')
  const documentId = childAttribute(root, 'id', 'root')
  const setId = childAttribute(root, 'setId', 'root')
  const version = childAttribute(root, 'versionNumber', 'value')
  const effectiveTime = childAttribute(root, 'effectiveTime', 'value')
  const documentTypeCode = childAttribute(root, 'code', 'code')
  if (
    documentId === undefined ||
    setId === undefined ||
    version === undefined ||
    !/^[1-9]\d*$/.test(version) ||
    effectiveTime === undefined ||
    !/^\d{8}[0-9.+-]*$/.test(effectiveTime) ||
    documentTypeCode === undefined
  ) {
    throw new Refusal('xml-not-spl')
  }
  return { documentId, setId, version: Number(version), effectiveTime, documentTypeCode }
}

// Every text node of the document (CDATA included), joined in document order with nothing between them.
export function documentText(document: Document): string {
  const parts: string[] = []
  // Iterative, so a deeply nested document cannot exhaust the call stack.
  let node: Node | null = document.firstChild
  while (node) {
    if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE) {
      parts.push(node.nodeValue ?? '')
    }
    if (node.firstChild) {
      node = node.firstChild
      continue
    }
    while (node && !node.nextSibling) node = node.parentNode === document ? null : node.parentNode
    node = node ? node.nextSibling : null
  }
  return parts.join('')
}
