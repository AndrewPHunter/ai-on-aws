import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { signInFormAction } from '../src/login-form.ts'

// Keycloak 26.8.2's sign-in page for the realm "lab" and the client "desk", as the identity service served it.
const page = readFileSync(new URL('fixtures/keycloak-sign-in.html', import.meta.url), 'utf8')

// The form's action in that page, with each &amp; decoded to &.
const EXPECTED_ACTION =
  'http://localhost:8090/realms/lab/login-actions/authenticate' +
  '?session_code=xBBmxkeNKVSXNa_yxJdH9PH2sfBfWKChwbmf-Fbz3u8' +
  '&execution=ccd49930-cd0b-4b2a-8f9a-479439cea04f' +
  '&client_id=desk' +
  '&tab_id=HzbwxUSxdVw' +
  '&client_data=eyJydSI6Imh0dHA6Ly9sb2NhbGhvc3Q6MzAwMC9hdXRoL2NhbGxiYWNrIiwicnQiOiJjb2RlIiwic3QiOiJmaXh0dXJlLXN0YXRlIn0'

test('I2. the sign-in form parser returns the decoded action URL, and refuses a page without the form', () => {
  assert.match(page, /action="[^"]*&amp;[^"]*"/, 'the fixture is expected to hold an entity-encoded action')
  assert.equal(signInFormAction(page), EXPECTED_ACTION)

  const withoutForm = page.replace(/<form\b[^>]*id="kc-form-login"[\s\S]*?<\/form>/, '')
  assert.notEqual(withoutForm, page, 'the fixture is expected to hold the sign-in form')
  assert.throws(() => signInFormAction(withoutForm), /no form with id "kc-form-login"/)
  assert.throws(() => signInFormAction('<html><body><p>Page not found</p></body></html>'), /no form with id "kc-form-login"/)
})
