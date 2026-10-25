const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(name, options = {}) {
  const preferences = { apiBaseUrl: 'https://router.example/api/', tpRuleSetName: 'test-route', routerSshHost: 'test-router', ...options.preferences };
  const toasts = [], requests = [], commands = [];
  const stored = options.stored ?? {};
  const api = {
    getPreferenceValues: () => preferences,
    showToast: async (toast) => toasts.push(toast),
    Toast: { Style: { Animated: 'progress', Success: 'success', Failure: 'failure' } },
    LocalStorage: { getItem: async (key) => stored[key], setItem: async (key, value) => { stored[key] = value; } },
  };
  const childProcess = { execFile(file, args, opts, callback) {
    commands.push({ file, args, opts });
    callback(null, options.commandOutput ?? 'https://www.example.org/page');
  } };
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(compiled, {
    exports, URL, Headers, AbortSignal, setTimeout,
    require: (id) => id === '@raycast/api' ? api : id === 'node:child_process' ? childProcess : require(id),
    fetch: async (url, init) => {
      const request = { path: url.pathname.replace('/api/', '') + url.search, method: init.method ?? 'GET', body: init.body && JSON.parse(init.body), headers: init.headers, redirect: init.redirect };
      requests.push(request);
      const result = await options.respond?.(request);
      if (result instanceof Response) return result;
      return Response.json({ success: true, data: result ?? {} });
    },
  }, { filename: name + '.js' });
  return { ...exports, toasts, requests, commands, stored };
}

const route = { id: 'test-id', name: 'test-rule', backend: 'hydraroute', enabled: true, routes: [{ interface: 'test-interface', tunnelId: 'test-tunnel' }], manualDomains: [] };
test('HR add preserves routing metadata and normalizes the hostname', async () => {
  const m = load('domain-actions', { respond: (r) => r.path === 'dns-routes/list' ? [route] : r.body });
  await m.runSafariDomainAction('add');
  assert.deepEqual(m.requests[1].body, { ...route, manualDomains: ['example.org'] });
  assert.equal(m.toasts.at(-1).style, 'success');
});
test('HR removal preserves a parent domain and other entries', async () => {
  const m = load('domain-actions', { respond: (r) => r.path === 'dns-routes/list' ? [{ ...route, manualDomains: ['org', 'example.org', 'other.example'] }] : r.body });
  await m.runSafariDomainAction('remove');
  assert.deepEqual(m.requests[1].body.manualDomains, ['org', 'other.example']);
});
test('ambiguous HR targets fail without writing', async () => {
  const m = load('domain-actions', { respond: () => [route, { ...route, id: 'second' }] });
  await m.runSafariDomainAction('add');
  assert.equal(m.requests.length, 1);
  assert.equal(m.toasts.at(-1).style, 'failure');
});
function tpResponse(r) {
  if (r.path === 'singbox/router/settings') return { routingMode: 'tproxy' };
  if (r.path === 'singbox/router/rulesets/list') return [{ tag: 'test-route', type: 'inline', materialized_srs: true, rules: [{ domain_suffix: ['other.example', 'example.org'], network: 'tcp' }] }];
  return r.body;
}
test('TP removal uses the configured ruleset and preserves other matchers', async () => {
  const m = load('domain-actions', { respond: tpResponse });
  await m.removeSafariDomainFromTp();
  const update = m.requests.at(-1).body;
  assert.equal(update.tag, 'test-route');
  assert.deepEqual(update.ruleSet.rules, [{ domain_suffix: ['other.example'], network: 'tcp' }]);
  assert.equal('materialized_srs' in update.ruleSet, false);
});
test('TP add uses the configured ruleset', async () => {
  const m = load('domain-actions', { commandOutput: 'https://new.example', respond: tpResponse });
  await m.addSafariDomainToTp();
  assert.deepEqual(m.requests.at(-1).body.ruleSet.rules[0].domain_suffix, ['other.example', 'example.org', 'new.example']);
});
test('a missing TProxy preference fails without writing', async () => {
  const m = load('domain-actions', { preferences: { tpRuleSetName: '' }, respond: tpResponse });
  await m.addSafariDomainToTp();
  assert.ok(m.requests.every((r) => r.method === 'GET'));
  assert.equal(m.toasts.at(-1).style, 'failure');
});
function zapretResponse(r) {
  if (r.path === 'zapret/hostlists') return { hostlists: [{ id: 'user', exists: true, editable: true }] };
  if (r.method === 'GET') return { id: 'user', content: 'other.example\n', revision: 'test-revision' };
  return {};
}
test('Zapret saves through the current API with its revision', async () => {
  const m = load('domain-actions', { respond: zapretResponse });
  await m.addSafariDomainToZapret();
  assert.equal(m.requests.at(-1).path, 'zapret/hostlist/save');
  assert.equal(m.requests.at(-1).method, 'POST');
  assert.deepEqual(m.requests.at(-1).body, { id: 'user', content: 'other.example\nexample.org\n', revision: 'test-revision' });
});
test('Zapret falls back for an older API with a plain-text 404', async () => {
  const m = load('domain-actions', { respond: (r) => r.path === 'zapret/hostlist/save' ? new Response('not found', { status: 404 }) : zapretResponse(r) });
  await m.addSafariDomainToZapret();
  assert.equal(m.requests.at(-1).path, 'zapret/hostlist');
  assert.equal(m.requests.at(-1).method, 'PUT');
  assert.equal(m.toasts.at(-1).style, 'success');
});
test('Zapret does not retry conflicts or report restart failure as success', async () => {
  for (const result of [Response.json({ error: true }, { status: 409 }), { restartError: 'test restart failure' }]) {
    const m = load('domain-actions', { respond: (r) => r.path === 'zapret/hostlist/save' ? result : zapretResponse(r) });
    await m.addSafariDomainToZapret();
    assert.equal(m.requests.length, 3);
    assert.equal(m.toasts.at(-1).style, 'failure');
  }
});
test('credentials stay in an authorization header and redirects are refused', async () => {
  const m = load('domain-actions', { preferences: { apiKey: 'test-only-key' }, respond: () => [] });
  await m.runSafariDomainAction('add');
  assert.equal(m.requests[0].headers.get('Authorization'), 'Bearer test-only-key');
  assert.equal(m.requests[0].redirect, 'error');
});
const media = `media:
  name: Media0
  port: 1
  manufacturer: Example
  product: Storage
  partition:
    uuid: test-uuid
    label: Example volume
    state: MOUNTED
    total: 1234
    used-by: service
    used-by: service
`;
test('storage parser discovers labels at runtime and deduplicates service usage', () => {
  const m = load('router-storage');
  const [partition] = m.parseRouterPartitions(media);
  assert.equal(partition.label, 'Example volume');
  assert.equal(partition.filesystem, 'test-uuid:');
  assert.deepEqual(Array.from(partition.uses), ['service']);
  assert.equal(partition.mounted, true);
  assert.equal(m.parseRouterPartitions(media.replace('test-uuid', "bad'; command")).length, 0);
});
test('unknown partitions stay locked and explicit local choices persist', async () => {
  const m = load('router-storage');
  const partitions = m.parseRouterPartitions(media);
  assert.equal(m.isDriveLocked(partitions[0], {}), true);
  assert.equal((await m.getDriveLockStates(partitions))['test-uuid'], true);
  await m.setDriveLocked(partitions[0], false);
  assert.equal((await m.getDriveLockStates(partitions))['test-uuid'], false);
});
test('storage uses the configured SSH host and rejects option injection', async () => {
  const m = load('router-storage', { commandOutput: media });
  await m.getRouterPartitions();
  assert.deepEqual(Array.from(m.commands[0].args.slice(-3)), ['--', 'test-router', "ndmc -c 'show media'"]);
  const bad = load('router-storage', { preferences: { routerSshHost: '-oProxyCommand=bad' } });
  await assert.rejects(bad.getRouterPartitions(), /valid Router SSH Host/);
  assert.equal(bad.commands.length, 0);
});

test('storage accepts legacy lock objects and safely ignores corrupt preferences', async () => {
  for (const raw of [{ 'test-uuid': false }, '{"test-uuid":false}']) {
    const m = load('router-storage', { stored: { 'locked-router-filesystems': raw } });
    assert.equal((await m.getDriveLockStates(m.parseRouterPartitions(media)))['test-uuid'], false);
  }
  const m = load('router-storage', { stored: { 'locked-router-filesystems': 'bad json' } });
  assert.equal((await m.getDriveLockStates(m.parseRouterPartitions(media)))['test-uuid'], true);
});
