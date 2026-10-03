import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

Object.assign(process.env, {
  DATABASE_URL: ':memory:', ENCRYPTION_SECRET: 'test-secret-key-must-be-long-and-secure-32-bytes!',
  PAYSTACK_SECRET_KEY: 'sk_test_mock', PAYSTACK_PLAN_CODE: 'PLN_pro', PAYSTACK_PLAN_AMOUNT: '300000',
  PAYSTACK_CURRENCY: 'NGN', FAKE_WORKERS: 'true', APP_BASE_URL: 'http://127.0.0.1:3000'
});
const { handleRequest, getWorkspaceEntitlement, getStrictWorkspaceEntitlement, expireStreamingSessions } = await import('../src/server.js');
const { initDatabase, db } = await import('../src/db.js');
const { config } = await import('../src/config.js');
initDatabase();
const fetchHttp = globalThis.fetch;
let server, base, sequence = 0, provider, calls;
const plan = { plan_code: 'PLN_pro', amount: 300000, currency: 'NGN', interval: 'monthly', domain: 'test' };
const payments = new Map();
function paid(reference, overrides = {}) {
  return { id: ++sequence, reference, status: 'success', amount: 300000, currency: 'NGN', plan: '',
    plan_object: plan, domain: 'test', paid_at: new Date().toISOString(), customer: { customer_code: 'CUS_shared' }, ...overrides };
}
function fixture(role = 'owner') {
  const id = `ws_${++sequence}`, user = `usr_${sequence}`, session = `sess_${sequence}`, csrf = `csrf_${sequence}`;
  const now = new Date().toISOString();
  db.run('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)', [id, 'Billing test', now]);
  db.run('INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)', [user, `${user}@example.com`, 'unused', now]);
  db.run('INSERT INTO memberships (workspace_id,user_id,role) VALUES (?,?,?)', [id, user, role]);
  db.run('INSERT INTO web_sessions (id,user_id,csrf_secret,expires_at) VALUES (?,?,?,?)', [session, user, csrf, new Date(Date.now()+86400000).toISOString()]);
  return { id, headers: { Cookie: `session_id=${session}; _csrf=${csrf}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } };
}
function checkout(workspace) {
  const reference = `ref_${++sequence}`, now = new Date().toISOString();
  db.run(`INSERT INTO paystack_checkouts (reference,workspace_id,plan_code,amount,currency,mode,status,created_at,updated_at)
    VALUES (?,?,'PLN_pro',300000,'NGN','test','pending',?,?)`, [reference, workspace.id, now, now]);
  payments.set(reference, paid(reference));
  return reference;
}
async function request(ws, route, body, method = 'POST') {
  const response = await fetchHttp(`${base}/api/workspaces/${ws.id}/billing${route}`, {
    method, headers: ws.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}
async function webhook(event, data, signature = null) {
  const body = JSON.stringify({ event, data });
  const response = await fetchHttp(`${base}/api/billing/webhook`, { method: 'POST', body, headers: {
    'Content-Type': 'application/json', 'x-paystack-signature': signature ?? crypto.createHmac('sha512', config.PAYSTACK_SECRET_KEY).update(body).digest('hex')
  } });
  return { status: response.status, body: await response.json() };
}
function subscription(code, extra = {}) {
  return { subscription_code: code, customer: { customer_code: 'CUS_shared' }, plan, domain: 'test', ...extra };
}
test.before(async () => {
  server = http.createServer(handleRequest);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(url.startsWith('https://api.paystack.co/'), 'Unexpected external network request');
    const path = new URL(url).pathname;
    calls.push(path);
    assert.ok(options.signal, 'Provider calls require a timeout');
    assert.equal(options.redirect, 'error');
    let data = await provider(path, options);
    if (data === undefined) {
      if (path === '/plan/PLN_pro') data = plan;
      else if (path === '/transaction/initialize') data = { reference: JSON.parse(options.body).reference, authorization_url: 'https://checkout.paystack.com/test' };
      else if (path.startsWith('/transaction/verify/')) data = payments.get(path.split('/').pop());
      else throw new Error(`Unmocked provider route: ${path}`);
    }
    return { ok: true, status: 200, json: async () => ({ status: true, data }) };
  };
});
test.beforeEach(() => { provider = async () => undefined; calls = []; });
test.after(async () => { globalThis.fetch = fetchHttp; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

test('public pricing validates the actual monthly NGN plan; wrong currency fails closed', async () => {
  let response = await fetchHttp(`${base}/api/billing/plan`);
  assert.equal((await response.json()).checkoutAvailable, true);
  provider = async () => ({ ...plan, currency: 'USD' });
  response = await fetchHttp(`${base}/api/billing/plan`);
  assert.equal((await response.json()).checkoutAvailable, false);
  assert.equal((await request(fixture(), '/checkout')).status, 503);
  assert.ok(!calls.includes('/transaction/initialize'));
});
test('configuration policy is identical with an in-memory database', async () => {
  const original = process.env.PAYSTACK_CURRENCY;
  try {
    process.env.PAYSTACK_CURRENCY = 'USD';
    assert.equal((await request(fixture(), '/checkout')).status, 503);
    assert.equal(calls.length, 0);
  } finally { process.env.PAYSTACK_CURRENCY = original; }
});
test('checkout rejects an invalid callback origin before contacting Paystack', async () => {
  const original = process.env.APP_BASE_URL;
  try {
    for (const origin of ['', 'null', 'http://public.example', 'https://user:password@app.example', 'https://app.example/path']) {
      process.env.APP_BASE_URL = origin;
      assert.equal((await request(fixture(), '/checkout')).status, 503);
    }
    assert.equal(calls.length, 0);
  } finally { process.env.APP_BASE_URL = original; }
});
test('concurrent checkout initialization has one durable reservation and one provider call', async () => {
  const ws = fixture();
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  provider = async path => { if (path === '/transaction/initialize') { entered(); await blocked; } };
  const first = request(ws, '/checkout');
  await started;
  const second = await request(ws, '/checkout');
  assert.equal(second.status, 409);
  release();
  const completed = await first;
  assert.equal(completed.status, 200);
  assert.equal((await request(ws, '/checkout')).body.reference, completed.body.reference);
  assert.equal(calls.filter(path => path === '/transaction/initialize').length, 1);
});
test('lookalike checkout domains and mismatched initialize references are rejected without retrying a new charge', async () => {
  for (const unsafe of ['https://evilpaystack.com/x', 'https://paystack.com.evil.test/x', 'https://u:p@paystack.com/x', 'http://paystack.com/x']) {
    const ws = fixture();
    provider = async (path, opts) => path === '/transaction/initialize' ? { reference: JSON.parse(opts.body).reference, authorization_url: unsafe } : undefined;
    assert.equal((await request(ws, '/checkout')).status, 500);
    assert.equal((await request(ws, '/checkout')).status, 409);
  }
  provider = async path => path === '/transaction/initialize' ? { reference: 'wrong', authorization_url: 'https://checkout.paystack.com/x' } : undefined;
  assert.equal((await request(fixture(), '/checkout')).status, 500);
});
test('uncertain initialization retains its reference and prevents duplicate checkout', async () => {
  const ws = fixture();
  provider = async path => { if (path === '/transaction/initialize') throw new Error('simulated timeout'); };
  assert.equal((await request(ws, '/checkout')).status, 503);
  assert.equal((await request(ws, '/checkout')).status, 409);
});
for (const [field, value] of Object.entries({ reference: 'wrong', domain: 'live', amount: 199, currency: 'USD', plan: 'PLN_wrong', paid_at: null, id: null, customer: null })) {
  test(`verification rejects ${field} mismatch without granting access`, async () => {
    const ws = fixture(), reference = checkout(ws);
    payments.set(reference, { ...payments.get(reference), [field]: value });
    assert.equal((await request(ws, '/verify', { reference })).status, 400);
    assert.equal(getWorkspaceEntitlement(ws.id).canStream, false);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM paystack_payments WHERE workspace_id = ?', [ws.id]).n, 0);
  });
}
test('plan objects and plan_object are accepted; callback and webhook share one ledger entry', async () => {
  for (const objectPlan of [false, true]) {
    const ws = fixture(), reference = checkout(ws);
    if (objectPlan) payments.get(reference).plan = plan;
    assert.equal((await request(ws, '/verify', { reference })).body.entitlement.plan, 'pro');
    assert.equal((await webhook('charge.success', payments.get(reference))).status, 200);
    assert.equal((await request(ws, '/verify', { reference })).body.verified, true);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM paystack_payments WHERE workspace_id = ?', [ws.id]).n, 1);
    assert.equal(getWorkspaceEntitlement(ws.id).manageAvailable, false, 'No guessed subscription binding');
  }
});
test('untrusted metadata and foreign workspace verification cannot claim a payment', async () => {
  const owner = fixture(), other = fixture(), reference = checkout(owner);
  assert.equal((await request(other, '/verify', { reference })).status, 403);
  const unbound = paid(`unknown_${++sequence}`, { metadata: { workspace_id: other.id } });
  payments.set(unbound.reference, unbound);
  assert.equal((await webhook('charge.success', unbound)).status, 503);
  assert.equal(getWorkspaceEntitlement(other.id).canStream, false);
});
test('subscription.create before payment retains a retryable candidate and never grants by status alone', async () => {
  const ws = fixture(), reference = checkout(ws), code = `SUB_${++sequence}`;
  let ready = false;
  provider = async path => path === `/subscription/${code}` ? subscription(code, { most_recent_invoice: ready ? { paid: true, transaction: { reference } } : null }) : undefined;
  const data = subscription(code, { metadata: { workspace_id: ws.id }, status: 'active' });
  assert.equal((await webhook('subscription.create', data)).status, 503);
  assert.equal(getWorkspaceEntitlement(ws.id).canStream, false);
  await request(ws, '/verify', { reference });
  ready = true;
  assert.equal((await webhook('subscription.create', data)).status, 200);
  assert.equal(getWorkspaceEntitlement(ws.id).manageAvailable, true);
});
test('invoice transaction binds exact workspaces even when they share a customer; renewals and cancellation are safe', async () => {
  const a = fixture(), b = fixture(), refA = checkout(a), refB = checkout(b), code = `SUB_${++sequence}`;
  await request(a, '/verify', { reference: refA });
  await request(b, '/verify', { reference: refB });
  provider = async path => path === `/subscription/${code}` ? subscription(code, { most_recent_invoice: { paid: true, transaction: { reference: refB } } }) : undefined;
  assert.equal((await webhook('subscription.create', subscription(code))).status, 200);
  assert.equal(db.queryOne('SELECT paystack_subscription_id FROM workspaces WHERE id = ?', [a.id]).paystack_subscription_id, null);
  assert.equal(db.queryOne('SELECT paystack_subscription_id FROM workspaces WHERE id = ?', [b.id]).paystack_subscription_id, code);
  const renewal = paid(`renew_${++sequence}`);
  payments.set(renewal.reference, renewal);
  const invoice = { domain: 'test', paid: true, amount: 300000, period_start: renewal.paid_at,
    period_end: new Date(Date.parse(renewal.paid_at) + 28*86400000).toISOString(),
    transaction: { reference: renewal.reference }, subscription: { subscription_code: code } };
  assert.equal((await webhook('invoice.update', invoice)).status, 200);
  const until = getWorkspaceEntitlement(b.id).paidUntil;
  assert.equal((await webhook('subscription.not_renew', subscription(code))).status, 200);
  assert.equal((await webhook('invoice.payment_failed', { domain: 'test', subscription: { subscription_code: code } })).status, 200);
  await webhook('invoice.update', invoice);
  assert.equal(getWorkspaceEntitlement(b.id).paidUntil, until);
  assert.equal(getWorkspaceEntitlement(b.id).cancelAtPeriodEnd, true);
  assert.equal(getWorkspaceEntitlement(b.id).canStream, true);
  assert.equal(db.queryOne('SELECT paid_until FROM paystack_payments WHERE reference = ?', [renewal.reference]).paid_until, invoice.period_end);
});

test('verified test payments cannot unlock live-mode access after changing keys', async () => {
  const ws = fixture(), reference = checkout(ws);
  assert.equal((await request(ws, '/verify', { reference })).body.entitlement.canStream, true);
  const key = process.env.PAYSTACK_SECRET_KEY;
  try {
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_mock';
    assert.equal(getWorkspaceEntitlement(ws.id).canStream, false);
    assert.equal((await request(ws, '/verify', { reference })).status, 400);
  } finally { process.env.PAYSTACK_SECRET_KEY = key; }
});

test('expiry allows only an already-live session to finish; reservations and overdue relays stop', async () => {
  const ws = fixture();
  const now = Date.now(), iso = offset => new Date(now + offset).toISOString();
  db.run('UPDATE workspaces SET paid_until = ? WHERE id = ?', [iso(-1000), ws.id]);
  for (const [suffix, status, deadline] of [['live', 'streaming', 60000], ['reserved', 'reserved', 60000], ['expired', 'streaming', -1]]) {
    const id = `${ws.id}_${suffix}`, device = `dev_${id}`;
    db.run("INSERT INTO devices (id,workspace_id,name,status,created_at) VALUES (?,?,?,'active',?)", [device, ws.id, device, iso(-10000)]);
    db.run('INSERT INTO stream_sessions (id,workspace_id,device_id,status,expires_at,started_at,created_at) VALUES (?,?,?,?,?,?,?)',
      [id, ws.id, device, status, iso(deadline), status === 'streaming' ? iso(-10000) : null, iso(-10000)]);
  }
  await expireStreamingSessions();
  assert.equal(db.queryOne('SELECT status FROM stream_sessions WHERE id = ?', [`${ws.id}_live`]).status, 'streaming');
  for (const suffix of ['reserved', 'expired']) assert.equal(db.queryOne('SELECT status FROM stream_sessions WHERE id = ?', [`${ws.id}_${suffix}`]).status, 'stopped');
});
test('calendar expiry clamps in UTC, old payments never truncate, and future timestamps fail', async () => {
  const ws = fixture(), reference = checkout(ws);
  payments.get(reference).paid_at = '2024-01-31T12:34:56.000Z';
  assert.equal((await request(ws, '/verify', { reference })).status, 200);
  assert.equal(getWorkspaceEntitlement(ws.id).paidUntil, '2024-02-29T12:34:56.000Z');
  const current = new Date(Date.now()+20*86400000).toISOString();
  db.run('UPDATE workspaces SET paid_until = ?, cancel_at_period_end = 1 WHERE id = ?', [current, ws.id]);
  const old = checkout(ws); payments.get(old).paid_at = '2023-01-31T12:34:56.000Z';
  await request(ws, '/verify', { reference: old });
  assert.equal(getWorkspaceEntitlement(ws.id).paidUntil, current);
  assert.equal(getWorkspaceEntitlement(ws.id).cancelAtPeriodEnd, true);
  const future = checkout(ws); payments.get(future).paid_at = new Date(Date.now()+86400000).toISOString();
  assert.equal((await request(ws, '/verify', { reference: future })).status, 400);
});
test('legacy active flags and stored limits cannot bypass expiry in either entitlement API', () => {
  const ws = fixture();
  db.run("UPDATE workspaces SET stripe_status = 'active', paystack_status = 'active', max_devices = 999, max_destinations = 999 WHERE id = ?", [ws.id]);
  for (const get of [getWorkspaceEntitlement, getStrictWorkspaceEntitlement]) {
    assert.equal(get(ws.id).canStream, false); assert.equal(get(ws.id).maxDevices, 0);
  }
  db.run('UPDATE workspaces SET paid_until = ? WHERE id = ?', [new Date(Date.now()+86400000).toISOString(), ws.id]);
  assert.equal(getStrictWorkspaceEntitlement(ws.id).maxDestinations, 3);
});
test('operators cannot mutate billing; invalid raw HMAC is rejected', async () => {
  const ws = fixture('operator');
  assert.equal((await request(ws, '', undefined, 'GET')).status, 200);
  for (const route of ['/checkout', '/verify', '/portal']) assert.equal((await request(ws, route, { reference: 'x' })).status, 403);
  assert.equal((await webhook('charge.success', {}, 'wrong')).status, 400);
});
test('management rejects credential-bearing and lookalike URLs', async () => {
  const ws = fixture(), reference = checkout(ws), code = `SUB_${++sequence}`;
  provider = async path => path === `/subscription/${code}` ? subscription(code, { most_recent_invoice: { paid: true, transaction: { reference } } }) : undefined;
  await webhook('subscription.create', subscription(code));
  provider = async path => path.includes('/manage/link') ? { link: 'https://evilpaystack.com/manage' } : undefined;
  assert.equal((await request(ws, '/portal')).status, 502);
  provider = async path => path.includes('/manage/link') ? { link: 'https://paystack.com/manage/test' } : undefined;
  assert.equal((await request(ws, '/portal')).status, 200);
});
