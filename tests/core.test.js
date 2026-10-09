'use strict';

// core.js against golden fixtures.
//
// Each scenario in tests/fixtures/scenarios/<name>.json drives a chat session
// with a fake host - fetch answered from tests/fixtures/kick/, a fake
// WebSocket fed the Pusher frames in tests/fixtures/frames/ exactly as Pusher
// sends them (`data` is a JSON string), and a clock and timers that only move
// when a step says so. Everything the session does is logged in order - the
// operations it emits, the requests it makes, and markers for each step - and
// compared with <name>.expected.json beside it.
//
// The expected files are the contract docs/core-protocol.md describes, so a
// change to one is a change to what the desktop app receives. To rewrite them
// after a deliberate change, run `UPDATE_FIXTURES=1 npm test` and read the
// diff before committing it.
//
// Steps:
//   {"join": true}           start, open the socket, Pusher's handshake and the
//                            chat subscription; unless the scenario sets
//                            "logJoin", the log starts after it
//   {"start": true}          session.start() on its own
//   {"open": true}           the socket opens
//   {"frame": "<name>"}      frames/<name>.json arrives on the socket
//   {"drop": true}           the socket closes under the session
//   {"advance": ms}          the clock moves on, firing timers due on the way
//   {"settings": {...}}      updateSettings with these changed
//   {"call": "<method>", "args": [...]}   any session method; its result is logged

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Settings = require('../site/settings.js');
const Core = require('../site/core.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const SCENARIOS = path.join(FIXTURES, 'scenarios');
const UPDATE = process.env.UPDATE_FIXTURES === '1';
const API = 'https://kick.com/api/v2';
const START = Date.parse('2026-09-08T18:00:00Z');

const DEFAULT_REST = {
  '/channels/xqc': 'kick/channel.json',
  '/channels/668/messages': 'kick/history-empty.json',
};

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8'));

// Lets every pending promise continuation run: the session awaits fetches,
// and those resolve on the microtask queue.
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

function fakeHost(rest, log) {
  let now = START;
  let seq = 0;
  const timers = new Map(); // id -> {at, seq, fn}
  const sockets = [];

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }

    // A healthy server: a ping is answered, so the clock can move on for
    // minutes without the relay deciding the socket is dead.
    send(text) {
      const frame = JSON.parse(text);
      this.sent.push(frame);
      if (frame.event === 'pusher:ping') {
        Promise.resolve().then(() => this.onmessage({ data: JSON.stringify({ event: 'pusher:pong', data: '{}' }) }));
      }
    }

    close() {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000 });
    }
  }

  const host = {
    now: () => now,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + Math.max(0, Number(ms) || 0), seq, fn });
      return seq;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    WebSocket: FakeSocket,
    // Only what the protocol promises a host's fetch has to do.
    fetch: async (url) => {
      const route = decodeURIComponent(url.startsWith(API) ? url.slice(API.length) : url);
      log.push({ fetch: route });
      const file = rest[route];
      if (!file) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }), text: async () => '' };
      const body = readJson(file);
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    },
  };

  // Fires the timers due before `ms` is up, in order, letting each one's
  // promises settle before the next.
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      let next = null;
      for (const t of timers.values()) {
        if (t.at <= until && (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq))) next = t;
      }
      if (!next) break;
      timers.delete(next.seq);
      now = next.at;
      next.fn();
      await settle();
    }
    now = until;
  }

  return { host, sockets, advance, timers };
}

function frameText(name) {
  return fs.readFileSync(path.join(FIXTURES, 'frames', `${name}.json`), 'utf8').trim();
}

async function runScenario(scenario) {
  const log = [];
  const rest = { ...DEFAULT_REST, ...(scenario.rest || {}) };
  const { host, sockets, advance } = fakeHost(rest, log);
  let settings = Settings.sanitize(scenario.settings || {});
  const session = Core.createChatSession({
    slug: scenario.slug || 'xqc',
    settings,
    host,
    overlay: scenario.overlay === true,
    config: { pusherAppKey: 'app-key', pusherCluster: 'us2' },
    // A copy: what is logged is what was sent, not what it became later.
    onOps: (ops) => log.push({ ops: JSON.parse(JSON.stringify(ops)) }),
  });
  const socket = () => sockets[sockets.length - 1];
  const deliver = async (name) => {
    log.push({ frame: name });
    socket().onmessage({ data: frameText(name) });
    await settle();
  };

  for (const step of scenario.steps) {
    if (step.join) {
      session.start();
      await settle();
      socket().readyState = 1;
      socket().onopen({});
      await deliver('connection-established');
      await deliver('subscribed-chat');
      if (!scenario.logJoin) log.length = 0;
    } else if (step.start) {
      session.start();
      await settle();
    } else if (step.open) {
      log.push({ open: true });
      socket().readyState = 1;
      socket().onopen({});
      await settle();
    } else if (step.frame) {
      await deliver(step.frame);
    } else if (step.drop) {
      log.push({ drop: true });
      socket().readyState = 3;
      socket().onclose({ code: 1006 });
      await settle();
    } else if (step.advance) {
      log.push({ advance: step.advance });
      await advance(step.advance);
    } else if (step.settings) {
      log.push({ settings: step.settings });
      settings = Settings.sanitize({ ...settings, ...step.settings });
      session.updateSettings(settings);
      await settle();
    } else if (step.call) {
      const args = step.args || [];
      const entry = { call: step.call, args };
      log.push(entry);
      const result = await session[step.call](...args);
      await settle();
      if (result !== undefined) entry.result = JSON.parse(JSON.stringify(result));
    } else {
      throw new Error(`unknown step ${JSON.stringify(step)}`);
    }
  }
  session.stop();
  return log;
}

const scenarios = fs.readdirSync(SCENARIOS).filter((f) => f.endsWith('.json') && !f.endsWith('.expected.json')).sort();

for (const file of scenarios) {
  const name = file.replace(/\.json$/, '');
  const scenario = JSON.parse(fs.readFileSync(path.join(SCENARIOS, file), 'utf8'));
  test(`core golden: ${name} - ${scenario.description}`, async () => {
    const log = await runScenario(scenario);
    const expectedPath = path.join(SCENARIOS, `${name}.expected.json`);
    if (UPDATE || !fs.existsSync(expectedPath)) {
      fs.writeFileSync(expectedPath, JSON.stringify(log, null, 2) + '\n');
      if (!UPDATE) assert.fail(`${name}.expected.json did not exist and was written; review it and run again`);
      return;
    }
    assert.deepEqual(log, JSON.parse(fs.readFileSync(expectedPath, 'utf8')));
  });
}

// Every operation in every expected file is plain JSON of the shapes the
// protocol names, so a fixture cannot quietly drift from the document.
test('core golden: every expected op is a protocol op', () => {
  const OPS = new Set(['append', 'update', 'remove', 'trim', 'clear', 'verify', 'pin', 'status', 'channel', 'history']);
  const PATCH = new Set(['color', 'badges', 'mentionsMe', 'repeats', 'deleted']);
  for (const file of fs.readdirSync(SCENARIOS).filter((f) => f.endsWith('.expected.json'))) {
    for (const entry of JSON.parse(fs.readFileSync(path.join(SCENARIOS, file), 'utf8'))) {
      for (const op of entry.ops || []) {
        assert.ok(OPS.has(op.op), `${file}: unknown op ${op.op}`);
        if (op.op === 'update') {
          for (const key of Object.keys(op.patch)) assert.ok(PATCH.has(key), `${file}: unknown patch field ${key}`);
        }
        if (op.op === 'append') assert.ok(['message', 'line', 'card'].includes(op.row.kind), `${file}: row kind ${op.row.kind}`);
      }
    }
  }
});

test('core: the protocol version is exported', () => {
  assert.equal(Core.CORE_PROTOCOL_VERSION, 1);
});

test('core: a host missing a function is refused, by name', () => {
  assert.throws(
    () => Core.createChatSession({ slug: 'xqc', settings: Settings.sanitize({}), host: { fetch() {} }, onOps() {} }),
    /WebSocket, setTimeout, clearTimeout, now/
  );
});

test('core: parseTime reads Kick timestamps without Date.parse', () => {
  assert.equal(Core.parseTime('2026-09-09T14:32:47.597067Z'), Date.UTC(2026, 8, 9, 14, 32, 47, 597));
  assert.equal(Core.parseTime('2026-09-08T18:29:25+00:00'), Date.UTC(2026, 8, 8, 18, 29, 25));
  assert.equal(Core.parseTime('2026-09-08T20:29:25+02:00'), Date.UTC(2026, 8, 8, 18, 29, 25));
  assert.ok(Number.isNaN(Core.parseTime('soon')));
});

// The desktop app runs these files in QuickJS: no fetch, no WebSocket, no
// timers, no Intl, no module loader. A bare V8 context with those taken away
// is the nearest thing Node has, so the three files are evaluated there as
// plain scripts, in the order a host loads them, and a session is run.
test('core: runs as plain scripts in a context with no browser and no Intl', async () => {
  const context = vm.createContext({});
  vm.runInContext('delete globalThis.Intl;', context);
  for (const name of ['settings.js', 'kick.js', 'core.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'site', name), 'utf8');
    vm.runInContext(source, context, { filename: name });
  }
  const globals = JSON.parse(vm.runInContext(
    'JSON.stringify([typeof fetch, typeof WebSocket, typeof setTimeout, typeof Intl, typeof window, typeof document, typeof BetterChatCore])',
    context
  ));
  assert.deepEqual(globals, ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'object']);

  // The host hands defaults.json over itself, and settings.js is ready then.
  const ready = vm.runInContext('BetterChatSettings.ready', context);
  vm.runInContext(`BetterChatSettings.useDefaults(${fs.readFileSync(path.join(__dirname, '..', 'site', 'defaults.json'), 'utf8')})`, context);
  await ready;

  const log = [];
  const { host, sockets } = fakeHost(DEFAULT_REST, log);
  context.host = host;
  context.record = (ops) => log.push({ ops: JSON.parse(JSON.stringify(ops)) });
  vm.runInContext(
    `globalThis.session = BetterChatCore.createChatSession({
      slug: 'xqc', settings: BetterChatSettings.sanitize({}), host, onOps: record,
      config: { pusherAppKey: 'app-key', pusherCluster: 'us2' },
    });
    session.start();`,
    context
  );
  await settle();
  const ws = sockets[0];
  ws.readyState = 1;
  ws.onopen({});
  ws.onmessage({ data: frameText('connection-established') });
  ws.onmessage({ data: frameText('subscribed-chat') });
  ws.onmessage({ data: frameText('message-rich') });
  ws.onmessage({ data: frameText('gift-7') });
  await settle();

  const ops = log.filter((e) => e.ops).flatMap((e) => e.ops);
  const message = ops.find((op) => op.op === 'append' && op.row.kind === 'message');
  assert.equal(message.row.msgId, 'm-rich');
  assert.ok(message.row.badges.some((b) => b.svg && b.svg.startsWith('<svg')));
  const gift = ops.find((op) => op.op === 'append' && op.row.kind === 'card');
  // A count is left for the host to format: there is no Intl to group digits.
  assert.deepEqual(gift.row.detail, [{ t: 'count', n: 7, unit: 'sub', units: 'subs' }]);
  vm.runInContext('session.stop()', context);
});

// ---------------------------------------------------------------------------
// Behaviour the golden files cannot show: what does not happen.
// ---------------------------------------------------------------------------

// A session joined to xqc with an empty history, socket open and subscribed.
async function joined(options = {}) {
  const log = [];
  const rest = { ...DEFAULT_REST, ...(options.rest || {}) };
  const fake = fakeHost(rest, log);
  if (options.wrapHost) options.wrapHost(fake.host);
  const ops = [];
  const session = Core.createChatSession({
    slug: 'xqc',
    settings: Settings.sanitize({}),
    host: fake.host,
    config: { pusherAppKey: 'app-key', pusherCluster: 'us2' },
    onOps: options.onOps || ((batch) => ops.push(...JSON.parse(JSON.stringify(batch)))),
    onError: options.onError,
  });
  session.start();
  await settle();
  const ws = fake.sockets[0];
  ws.readyState = 1;
  ws.onopen({});
  ws.onmessage({ data: frameText('connection-established') });
  ws.onmessage({ data: frameText('subscribed-chat') });
  await settle();
  return { session, ops, log, ...fake };
}

test('core: nothing is emitted, and no timer is left, after stop()', async () => {
  let answer;
  const { session, ops, sockets, advance, timers } = await joined({
    // A lookup that is still on its way when the session stops.
    wrapHost: (host) => {
      const fetch = host.fetch;
      host.fetch = (url) => (url.includes('/users/') ? new Promise((resolve) => { answer = resolve; }) : fetch(url));
    },
  });
  const ws = sockets[0];
  const onmessage = ws.onmessage;
  onmessage({ data: frameText('message-mentions-me') });
  await advance(400);
  assert.equal(typeof answer, 'function', 'the lookup is in flight');

  session.stop();
  ops.length = 0;
  answer({ ok: true, status: 200, json: async () => ({ username: 'viewerMe' }), text: async () => '' });
  await settle();
  // A frame Pusher had already handed over, through the handler as it was.
  onmessage({ data: frameText('message-bob') });
  session.note('late');
  session.clearLocal();
  session.updateSettings(Settings.sanitize({ monocolor: true }));
  session.trim();
  await advance(60000);
  await settle();
  assert.deepEqual(ops, []);
  assert.equal(ws.onmessage, null, 'the socket is let go of');
  assert.equal(timers.size, 0, 'no timer survives stop()');
  assert.equal(sockets.length, 1, 'and nothing reconnects');
});

test('core: a host whose onOps throws does not lose the connection', async () => {
  const errors = [];
  let failNext = false;
  const { sockets, advance } = await joined({
    onOps: () => {
      if (failNext) {
        failNext = false;
        throw new Error('renderer bug');
      }
    },
    onError: (e) => errors.push(e.message),
  });
  failNext = true;
  sockets[0].readyState = 3;
  sockets[0].onclose({ code: 1006 });
  assert.deepEqual(errors, ['renderer bug']);
  await advance(1000);
  assert.equal(sockets.length, 2, 'reconnected on schedule');
});

test('core: without onError, an onOps exception is rethrown on a timer of its own', async () => {
  let failNext = false;
  const { sockets, timers } = await joined({
    onOps: () => {
      if (failNext) {
        failNext = false;
        throw new Error('renderer bug');
      }
    },
  });
  failNext = true;
  const before = new Set(timers.keys());
  sockets[0].readyState = 3;
  assert.doesNotThrow(() => sockets[0].onclose({ code: 1006 }));
  const added = [...timers.entries()].filter(([id]) => !before.has(id)).map(([, t]) => t);
  assert.ok(added.some((t) => {
    try {
      t.fn();
      return false;
    } catch (e) {
      return e.message === 'renderer bug';
    }
  }), 'the error surfaces from a host timer');
});

test('core: host functions are only ever called as plain functions', async () => {
  // This file is strict, so `this` is undefined for a plain call.
  const strict = (fn, name) => function (...args) {
    if (this !== undefined) throw new Error(`${name} was called as a method`);
    return fn(...args);
  };
  const { session, sockets, advance, ops } = await joined({
    wrapHost: (host) => {
      for (const name of ['fetch', 'setTimeout', 'clearTimeout', 'now']) host[name] = strict(host[name], name);
    },
    rest: { '/channels/xqc/users/Carol': 'kick/user-carol.json' },
  });
  sockets[0].onmessage({ data: frameText('message-mentions-me') });
  sockets[0].onmessage({ data: frameText('pin-created') });
  await advance(1000);
  await session.userCard('Carol');
  session.cachedUserCard('carol');
  sockets[0].readyState = 3;
  sockets[0].onclose({ code: 1006 });
  await advance(1000);
  session.stop();
  assert.ok(ops.some((op) => op.op === 'verify' && op.key === 'carol'));
});

test('core: mention lookups are strictly one at a time', async () => {
  const pending = [];
  const { sockets, advance } = await joined({
    wrapHost: (host) => {
      const fetch = host.fetch;
      host.fetch = (url) => (url.includes('/users/') ? new Promise((resolve) => pending.push(resolve)) : fetch(url));
    },
  });
  const lookups = () => pending.length;
  sockets[0].onmessage({ data: frameText('message-mentions-me') }); // @viewerMe and @Carol
  await advance(400);
  assert.equal(lookups(), 1);
  await advance(2000);
  assert.equal(lookups(), 1, 'the second waits while the first is unanswered');
  pending[0]({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  await settle();
  await advance(399);
  assert.equal(lookups(), 1, 'and keeps its spacing after the answer');
  await advance(1);
  assert.equal(lookups(), 2);
});
