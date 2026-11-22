// I28 to I30: what platform/identity/realm/lab-realm.json promises about roles, capability scopes, clients and
// people (the realm's contract: roles and scopes, clients, users with fixed ids). Read from the tracked file.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

type Mapper = { name: string; protocolMapper: string; config?: Record<string, string> }
type ClientScope = { name: string; protocolMappers?: Mapper[] }
type Client = {
  clientId: string
  secret?: string
  publicClient?: boolean
  bearerOnly?: boolean
  standardFlowEnabled?: boolean
  implicitFlowEnabled?: boolean
  directAccessGrantsEnabled?: boolean
  serviceAccountsEnabled?: boolean
  attributes?: Record<string, string>
  defaultClientScopes?: string[]
  optionalClientScopes?: string[]
  protocolMappers?: Mapper[]
}
type User = { id?: string; username: string; firstName?: string; lastName?: string; serviceAccountClientId?: string; realmRoles?: string[] }
type Realm = {
  roles?: { realm?: { name: string }[] }
  clientScopes?: ClientScope[]
  scopeMappings?: { clientScope?: string; roles?: string[] }[]
  clients?: Client[]
  users?: User[]
}

const realm = JSON.parse(readFileSync(new URL('../realm/lab-realm.json', import.meta.url), 'utf8')) as Realm
const clients = realm.clients ?? []
const users = realm.users ?? []

const sorted = (values: readonly string[]): string[] => [...values].sort()

// ---------- the contract's two tables ----------

/** Scope -> the audience(s) it names and the roles that grant it. */
const SCOPES: Record<string, { audiences: string[]; roles: string[] }> = {
  'agents:intake': { audiences: ['intake-handwritten', 'intake-strands'], roles: ['desk', 'medical-information'] },
  'agents:expert': { audiences: ['expert'], roles: ['medical-information', 'evaluation'] },
  'cases:write': { audiences: ['case-system'], roles: ['desk', 'medical-information'] },
  'cases:lookup': { audiences: ['case-system'], roles: ['desk', 'medical-information'] },
  'cases:read': { audiences: ['case-system'], roles: ['safety-reviewer', 'auditor'] },
  'cases:review': { audiences: ['case-system'], roles: ['safety-reviewer'] },
  'labels:search': { audiences: ['knowledge'], roles: ['medical-information', 'evaluation', 'knowledge-gate'] },
}

type Kind = 'web' | 'agent' | 'machine' | 'audience'

/** Client -> its kind and the optional scopes it may ask for. */
const CLIENTS: Record<string, { kind: Kind; optional: string[] }> = {
  desk: { kind: 'web', optional: ['agents:intake', 'agents:expert', 'cases:read', 'cases:review'] },
  'intake-handwritten': { kind: 'agent', optional: ['cases:write', 'cases:lookup'] },
  'intake-strands': { kind: 'agent', optional: ['cases:write', 'cases:lookup'] },
  expert: { kind: 'agent', optional: ['labels:search'] },
  evaluation: { kind: 'machine', optional: ['agents:expert'] },
  'knowledge-gate': { kind: 'machine', optional: ['labels:search'] },
  'case-system': { kind: 'audience', optional: [] },
  knowledge: { kind: 'audience', optional: [] },
}

const BUILT_IN_SCOPES = ['basic', 'profile', 'email']
const STAFF_ROLES = ['desk', 'medical-information', 'safety-reviewer', 'auditor']
const MACHINE_ROLES = ['evaluation', 'knowledge-gate']

const scopeNamed = (name: string): ClientScope | undefined => (realm.clientScopes ?? []).find((scope) => scope.name === name)
const clientNamed = (id: string): Client | undefined => clients.find((client) => client.clientId === id)

/** The roles the realm's scope mappings grant a scope by. */
function rolesGranting(scope: string): string[] {
  return (realm.scopeMappings ?? []).filter((mapping) => mapping.clientScope === scope).flatMap((mapping) => mapping.roles ?? [])
}

/** The clients a scope names as audience, through the audience mappers inside it. */
function audiencesNamed(scope: string): string[] {
  return (scopeNamed(scope)?.protocolMappers ?? [])
    .filter((mapper) => mapper.protocolMapper === 'oidc-audience-mapper')
    .map((mapper) => mapper.config?.['included.client.audience'] ?? mapper.config?.['included.custom.audience'] ?? '')
}

test('I28. a role that grants an agent\'s scope grants every scope that agent\'s client may ask for', () => {
  const agentScopes = (realm.clientScopes ?? []).map((scope) => scope.name).filter((name) => name.startsWith('agents:'))
  assert.ok(agentScopes.length >= 2, `the realm names agent scopes: ${agentScopes.join(', ')}`)
  for (const agentScope of agentScopes) {
    const agents = audiencesNamed(agentScope)
    assert.ok(agents.length >= 1, `${agentScope} names no agent as audience`)
    for (const agent of agents) {
      const client = clientNamed(agent)
      assert.ok(client !== undefined, `${agentScope} names ${agent}, which is not a client`)
      for (const role of rolesGranting(agentScope)) {
        for (const needed of client.optionalClientScopes ?? []) {
          assert.ok(
            rolesGranting(needed).includes(role),
            `role ${role} grants ${agentScope} (the agent ${agent}) but not ${needed}, which ${agent} asks for on the caller's behalf`,
          )
        }
      }
    }
  }
})

test('I29. every scope and every client in the realm file is as the contract\'s tables say', () => {
  // The scopes: exactly the built-in three and the seven capabilities, each naming its audiences and granted by its roles.
  assert.deepEqual(sorted((realm.clientScopes ?? []).map((scope) => scope.name)), sorted([...BUILT_IN_SCOPES, ...Object.keys(SCOPES)]))
  for (const [name, { audiences, roles }] of Object.entries(SCOPES)) {
    assert.deepEqual(sorted(audiencesNamed(name)), sorted(audiences), `${name}: the audiences it names`)
    assert.deepEqual(sorted(rolesGranting(name)), sorted(roles), `${name}: the roles that grant it`)
  }
  for (const name of BUILT_IN_SCOPES) {
    const audienceMappers = (scopeNamed(name)?.protocolMappers ?? []).filter((mapper) => mapper.protocolMapper === 'oidc-audience-mapper')
    assert.deepEqual(audienceMappers, [], `${name} names an audience`)
  }

  // The clients: exactly the eight.
  assert.deepEqual(sorted(clients.map((client) => client.clientId)), sorted(Object.keys(CLIENTS)))
  for (const client of clients) {
    const id = client.clientId
    const row = CLIENTS[id]
    assert.ok(row !== undefined, `${id} is not in the contract`)
    assert.deepEqual(sorted(client.optionalClientScopes ?? []), sorted(row.optional), `${id}: the scopes it may ask for`)
    for (const name of client.defaultClientScopes ?? []) assert.ok(BUILT_IN_SCOPES.includes(name), `${id}: default scope ${name}`)

    // Token exchange is on for the agents and off for every other client.
    const exchange = client.attributes?.['standard.token.exchange.enabled']
    assert.equal(exchange, row.kind === 'agent' ? 'true' : 'false', `${id}: standard.token.exchange.enabled`)
    // No password grant and no implicit flow anywhere.
    assert.equal(client.directAccessGrantsEnabled, false, `${id}: the password grant`)
    assert.equal(client.implicitFlowEnabled, false, `${id}: the implicit flow`)

    // Its kind.
    assert.equal(client.publicClient, false, `${id}: publicClient`)
    assert.equal(client.bearerOnly, false, `${id}: bearerOnly`)
    assert.equal(client.standardFlowEnabled, row.kind === 'web', `${id}: the authorization code flow`)
    assert.equal(client.serviceAccountsEnabled, row.kind === 'machine', `${id}: the service account`)
    if (row.kind === 'web') assert.equal(client.attributes?.['pkce.code.challenge.method'], 'S256', `${id}: PKCE`)

    // Audiences come from scopes only: no client adds one of its own.
    const audienceMappers = (client.protocolMappers ?? []).filter((mapper) => mapper.protocolMapper === 'oidc-audience-mapper')
    assert.deepEqual(audienceMappers.map((mapper) => mapper.name), [], `${id}: an audience mapper on the client`)

    // A client that issues tokens carries a client_id claim equal to its id, and the roles claim.
    const mappers = client.protocolMappers ?? []
    if (row.kind === 'audience') {
      assert.deepEqual(mappers, [], `${id}: issues no token, so carries no mapper`)
      continue
    }
    const clientIdMapper = mappers.find((mapper) => mapper.protocolMapper === 'oidc-hardcoded-claim-mapper' && mapper.config?.['claim.name'] === 'client_id')
    assert.ok(clientIdMapper !== undefined, `${id}: no client_id claim`)
    assert.equal(clientIdMapper.config?.['claim.value'], id, `${id}: the client_id claim`)
    assert.equal(clientIdMapper.config?.['access.token.claim'], 'true', `${id}: the client_id claim is not in the access token`)
    const rolesMapper = mappers.find((mapper) => mapper.protocolMapper === 'oidc-usermodel-realm-role-mapper')
    assert.ok(rolesMapper !== undefined, `${id}: no roles claim`)
    assert.equal(rolesMapper.config?.['claim.name'], 'roles', `${id}: the roles claim's name`)
    assert.equal(rolesMapper.config?.multivalued, 'true', `${id}: roles is not a list`)
    assert.equal(rolesMapper.config?.['access.token.claim'], 'true', `${id}: roles is not in the access token`)
  }
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('I30. people and service accounts have fixed ids; a person holds one staff role and no machine role; a machine its one role', () => {
  // Today's ids, so sub does not change for the two people who existed before.
  assert.equal(users.find((user) => user.username === 'riley.reviewer')?.id, '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f01')
  assert.equal(users.find((user) => user.username === 'dana.desk')?.id, '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f02')

  const ids = users.map((user) => user.id)
  assert.equal(new Set(ids).size, ids.length, 'two users share an id')
  const roleNames = (user: User): string[] => (user.realmRoles ?? []).filter((role) => role !== 'default-roles-lab')

  const people = users.filter((user) => user.serviceAccountClientId === undefined)
  assert.deepEqual(sorted(people.map((user) => user.username)), sorted(['dana.desk', 'riley.reviewer', 'morgan.medinfo', 'avery.auditor']))
  for (const user of people) {
    assert.match(user.id ?? '', UUID, `${user.username}: no fixed id`)
    const roles = roleNames(user)
    const machine = roles.filter((role) => MACHINE_ROLES.includes(role))
    assert.deepEqual(machine, [], `${user.username} holds a machine role`)
    const staff = roles.filter((role) => STAFF_ROLES.includes(role))
    assert.equal(staff.length, 1, `${user.username} holds ${staff.length} staff roles: ${staff.join(', ')}`)
  }

  const machines = clients.filter((client) => client.serviceAccountsEnabled === true).map((client) => client.clientId)
  assert.deepEqual(sorted(machines), sorted(MACHINE_ROLES))
  const accounts = users.filter((user) => user.serviceAccountClientId !== undefined).map((user) => user.serviceAccountClientId ?? '')
  assert.deepEqual(sorted(accounts), sorted(machines), 'a service account declared for a client without one')
  for (const clientId of machines) {
    const account = users.filter((user) => user.serviceAccountClientId === clientId)
    assert.equal(account.length, 1, `${clientId}: ${account.length} service accounts declared`)
    const [user] = account
    assert.ok(user !== undefined)
    assert.equal(user.username, `service-account-${clientId}`)
    assert.match(user.id ?? '', UUID, `${user.username}: no fixed id`)
    assert.ok((user.firstName ?? '') !== '' && (user.lastName ?? '') !== '', `${user.username}: no first and last name`)
    assert.deepEqual(roleNames(user), [clientId], `${user.username}: its one role`)
  }
})
