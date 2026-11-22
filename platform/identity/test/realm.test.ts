// The identity piece's invariants 2 to 4 ("Always true" in platform/identity/README.md), each computed from the
// tracked realm file. Whether Keycloak honours the file is the gate's to show.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

type Client = {
  clientId: string
  directAccessGrantsEnabled?: boolean
  serviceAccountsEnabled?: boolean
  attributes?: Record<string, string>
  optionalClientScopes?: string[]
}
type Realm = {
  clientScopes?: { name: string; protocolMappers?: { protocolMapper: string; config?: Record<string, string> }[] }[]
  scopeMappings?: { clientScope?: string; roles?: string[] }[]
  clients?: Client[]
  users?: { id?: string; username: string; serviceAccountClientId?: string }[]
}

const realm = JSON.parse(readFileSync(new URL('../realm/lab-realm.json', import.meta.url), 'utf8')) as Realm
const clients = realm.clients ?? []

const rolesGranting = (scope: string): string[] =>
  (realm.scopeMappings ?? []).filter((mapping) => mapping.clientScope === scope).flatMap((mapping) => mapping.roles ?? [])

/** The clients a scope names as audience. */
const audiencesOf = (scope: string): string[] =>
  (realm.clientScopes?.find((entry) => entry.name === scope)?.protocolMappers ?? [])
    .filter((mapper) => mapper.protocolMapper === 'oidc-audience-mapper')
    .map((mapper) => mapper.config?.['included.client.audience'] ?? '')

/** An agent's client: one a scope names as audience, and which itself asks for scopes to call on. */
const agents = clients.filter(
  (client) =>
    (client.optionalClientScopes ?? []).length > 0 &&
    (realm.clientScopes ?? []).some((scope) => audiencesOf(scope.name).includes(client.clientId)),
)

test('identity 2. a role that lets someone run an agent also grants every scope that agent\'s client may ask for', () => {
  let checked = 0
  for (const scope of realm.clientScopes ?? []) {
    for (const agent of agents.filter((client) => audiencesOf(scope.name).includes(client.clientId))) {
      for (const role of rolesGranting(scope.name)) {
        for (const needed of agent.optionalClientScopes ?? []) {
          assert.ok(rolesGranting(needed).includes(role), `${role} runs ${agent.clientId} (${scope.name}) but is not granted ${needed}`)
          checked += 1
        }
      }
    }
  }
  assert.ok(checked > 0, 'no role lets anyone run an agent')
})

test('identity 3. only an agent\'s client can exchange a token, and no client takes a password in place of a sign-in', () => {
  for (const client of clients) {
    if (client.attributes?.['standard.token.exchange.enabled'] === 'true') assert.ok(agents.includes(client), `${client.clientId} can exchange a token`)
    assert.equal(client.directAccessGrantsEnabled, false, `${client.clientId} takes a password`)
  }
})

test('identity 4. every person and every machine account has a fixed identifier', () => {
  const users = realm.users ?? []
  for (const user of users) assert.match(user.id ?? '', /^[0-9a-f-]{36}$/, `${user.username} has no fixed id`)
  assert.equal(new Set(users.map((user) => user.id)).size, users.length, 'two accounts share an id')
  // A machine client whose service account is not declared gets one with a new id at every start.
  for (const machine of clients.filter((client) => client.serviceAccountsEnabled === true)) {
    assert.ok(users.some((user) => user.serviceAccountClientId === machine.clientId), `${machine.clientId}: its service account is not declared`)
  }
})
