// Reads the URL that Keycloak's sign-in page posts the username and password to.

const FORM_ID = 'kc-form-login'

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Decodes the character references that can appear in an HTML attribute value. Unknown names are an error. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10))
    const named = NAMED[body]
    if (named === undefined) throw new Error(`sign-in form: unknown HTML entity ${whole} in the form's action`)
    return named
  })
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
  if (match === null) return undefined
  return match[1] ?? match[2]
}

/**
 * The absolute action URL of the sign-in form (the <form> with id "kc-form-login"), entities decoded.
 * Throws, saying why, when the page has no such form, the form has no action, or the action is not an
 * absolute http(s) URL.
 */
export function signInFormAction(html: string): string {
  for (const match of html.matchAll(/<form\b[^>]*>/gi)) {
    const tag = match[0]
    if (attribute(tag, 'id') !== FORM_ID) continue
    const raw = attribute(tag, 'action')
    if (raw === undefined || raw === '') throw new Error(`sign-in form: the form "${FORM_ID}" has no action`)
    const action = decodeEntities(raw)
    let url: URL
    try {
      url = new URL(action)
    } catch {
      throw new Error(`sign-in form: the action of "${FORM_ID}" is not an absolute URL`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`sign-in form: the action of "${FORM_ID}" is not an http(s) URL`)
    }
    return action
  }
  throw new Error(`sign-in form: the page has no form with id "${FORM_ID}"; it is not Keycloak's sign-in page`)
}
