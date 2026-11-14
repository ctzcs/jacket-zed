'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const {
  MessageReader, encodeMessage, ProxySession, mergeFolds,
} = require('../resources/jai-region-proxy.cjs');

const uri = 'file:///ui.jai';
const text = 'package ui\n//@region HUD\nui_hud :: () {\n    x := 1\n}\n//@endregion\n';
const symbol = {
  name: 'ui_hud', kind: 12, detail: '()',
  range: { start: { line: 2, character: 0 }, end: { line: 4, character: 1 } },
  selectionRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } },
};
function request(id, method, params = {}) { return { jsonrpc: '2.0', id, method, params }; }
function notification(method, params) { return { jsonrpc: '2.0', method, params }; }
function setup(capabilities = {}) {
  const server = [], client = [], reports = [];
  const session = new ProxySession(m => server.push(m), m => client.push(m), m => reports.push(m));
  session.fromClient(request(1, 'initialize', { capabilities: {
    textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } },
  } }));
  session.fromServer({ jsonrpc: '2.0', id: 1, result: { capabilities } });
  return { session, server, client, reports };
}
function open(session, source = text) {
  session.fromClient(notification('textDocument/didOpen', {
    textDocument: { uri, languageId: 'jai', version: 1, text: source },
  }));
}
function query(id, method, extra = {}) {
  return request(id, `textDocument/${method}`, { textDocument: { uri }, ...extra });
}

test('LSP framing handles UTF-8, one-byte fragments, and multiple frames', () => {
  const messages = [request(1, 'test', { title: '界面😀' }), { jsonrpc: '2.0', id: 2, result: null }];
  const frames = Buffer.concat(messages.map(encodeMessage));
  const received = [];
  const reader = new MessageReader(m => received.push(m));
  for (const byte of frames) reader.push(Buffer.from([byte]));
  reader.finish();
  assert.deepEqual(received, messages);
});

test('LSP framing rejects missing lengths, duplicate lengths, and truncation', () => {
  for (const header of ['Other: 2', 'Content-Length: -1', 'Content-Length: 2\r\nContent-Length: 2']) {
    assert.throws(() => new MessageReader(() => {}).push(Buffer.from(`${header}\r\n\r\n{}`)));
  }
  const reader = new MessageReader(() => {});
  reader.push(Buffer.from('Content-Length: 10\r\n\r\n{}'));
  assert.throws(() => reader.finish(), /Truncated/);
});

test('initialize negotiates UTF-16 and augments only region-related capabilities', () => {
  const { server, client } = setup({ hoverProvider: true, textDocumentSync: 2 });
  assert.deepEqual(server[0].params.capabilities.general.positionEncjaigs, ['utf-16']);
  assert.equal(client[0].result.capabilities.hoverProvider, true);
  assert.equal(client[0].result.capabilities.textDocumentSync, 2);
  assert.equal(client[0].result.capabilities.foldingRangeProvider, true);
  assert.equal(client[0].result.capabilities.documentSymbolProvider, true);
});

test('a non-UTF-16 server remains unmodified rather than returning wrong ranges', () => {
  const { session, server, client } = setup({ positionEncjaig: 'utf-8' });
  assert.equal(client[0].result.capabilities.foldingRangeProvider, undefined);
  open(session);
  session.fromClient(query(2, 'foldingRange'));
  assert.equal(server.at(-1).id, 2);
});

test('regions fold locally without forwarding an unsupported jailsp method', () => {
  const { session, server, client } = setup();
  open(session);
  const count = server.length;
  session.fromClient(query(2, 'foldingRange'));
  assert.equal(server.length, count);
  assert.ok(client.at(-1).result.some(f => f.startLine === 1 && f.endLine === 5));
  assert.ok(client.at(-1).result.some(f => f.startLine === 2 && f.endLine === 4));
});

test('jailsp document symbols become children of the region and keep metadata', () => {
  const { session, server, client } = setup({ documentSymbolProvider: true });
  open(session);
  session.fromClient(query(2, 'documentSymbol', { partialResultToken: 'symbols' }));
  assert.equal(server.at(-1).params.partialResultToken, undefined);
  session.fromServer({ jsonrpc: '2.0', id: 2, result: [symbol] });
  assert.equal(client.at(-1).result[0].name, 'HUD');
  assert.equal(client.at(-1).result[0].children[0].name, symbol.name);
  assert.equal(client.at(-1).result[0].children[0].detail, symbol.detail);
});

test('upstream folding ranges are merged and duplicate ranges removed', () => {
  const { session, client } = setup({ foldingRangeProvider: {} });
  open(session);
  session.fromClient(query(2, 'foldingRange'));
  const extra = { startLine: 0, endLine: 5, collapsedText: 'upstream' };
  session.fromServer({ jsonrpc: '2.0', id: 2, result: [extra] });
  assert.ok(client.at(-1).result.some(f => f.collapsedText === 'upstream'));
  assert.equal(mergeFolds([extra], [extra]).length, 1);
});

test('native jailsp ordinary folds are preserved without adding competing local folds', () => {
  const { session, client } = setup({ foldingRangeProvider: true });
  open(session);
  session.fromClient(query(2, 'foldingRange'));
  const native = { startLine: 2, endLine: 4, collapsedText: 'function' };
  session.fromServer({ jsonrpc: '2.0', id: 2, result: [native] });
  assert.deepEqual(client.at(-1).result.filter(f => f.kind !== 'region'), [native]);
  assert.equal(client.at(-1).result.filter(f => f.kind === 'region').length, 1);
});

test('incremental edits recompute ranges and full edits can remove them', () => {
  const { session, client } = setup();
  open(session);
  session.fromClient(notification('textDocument/didChange', {
    textDocument: { uri, version: 2 }, contentChanges: [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: '\n',
    }],
  }));
  session.fromClient(query(2, 'foldingRange'));
  assert.ok(client.at(-1).result.some(f => f.startLine === 2 && f.endLine === 6));
  session.fromClient(notification('textDocument/didChange', {
    textDocument: { uri, version: 3 }, contentChanges: [{ text: 'package ui\n' }],
  }));
  session.fromClient(query(3, 'foldingRange'));
  assert.deepEqual(client.at(-1).result, []);
});

test('closed documents release their text and ranges', () => {
  const { session, client } = setup();
  open(session);
  session.fromClient(notification('textDocument/didClose', { textDocument: { uri } }));
  session.fromClient(query(2, 'foldingRange'));
  assert.deepEqual(client.at(-1).result, []);
  assert.equal(session.documents.size, 0);
});

test('invalid incremental changes drop cached text instead of serving stale ranges', () => {
  const { session, client, reports } = setup();
  open(session);
  session.fromClient(notification('textDocument/didChange', {
    textDocument: { uri, version: 2 }, contentChanges: [{
      range: { start: { line: 999, character: 0 }, end: { line: 999, character: 1 } }, text: '',
    }],
  }));
  session.fromClient(query(2, 'foldingRange'));
  assert.deepEqual(client.at(-1).result, []);
  assert.equal(reports.length, 1);
});

test('in-flight symbols are rejected if their document changes', () => {
  const { session, client } = setup({ documentSymbolProvider: true });
  open(session);
  session.fromClient(query(2, 'documentSymbol'));
  session.fromClient(notification('textDocument/didChange', {
    textDocument: { uri, version: 2 }, contentChanges: [{ text: 'package ui\n' }],
  }));
  session.fromServer({ jsonrpc: '2.0', id: 2, result: [symbol] });
  assert.equal(client.at(-1).error.code, -32801);
});

test('server requests with colliding IDs, notifications, and unrelated replies pass through', () => {
  const { session, client, server } = setup({ documentSymbolProvider: true });
  open(session);
  session.fromClient(query('same', 'documentSymbol'));
  const serverRequest = request('same', 'workspace/configuration', { items: [] });
  session.fromServer(serverRequest);
  assert.equal(client.at(-1), serverRequest);
  assert.ok(session.pending.has('same'));
  const reply = { jsonrpc: '2.0', id: 'same', result: [] };
  session.fromClient(reply);
  assert.equal(server.at(-1), reply);
  session.fromServer({ jsonrpc: '2.0', id: 'same', result: [symbol] });
  assert.equal(client.at(-1).result[0].name, 'HUD');
  const diagnostic = notification('textDocument/publishDiagnostics', { uri, diagnostics: [] });
  session.fromServer(diagnostic);
  assert.equal(client.at(-1), diagnostic);
});

test('cancellation errors remain errors and cancellation notifications are forwarded', () => {
  const { session, server, client } = setup({ documentSymbolProvider: true });
  open(session);
  session.fromClient(query(2, 'documentSymbol'));
  const cancel = notification('$/cancelRequest', { id: 2 });
  session.fromClient(cancel);
  assert.equal(server.at(-1), cancel);
  const error = { jsonrpc: '2.0', id: 2, error: { code: -32800, message: 'cancelled' } };
  session.fromServer(error);
  assert.equal(client.at(-1), error);
});

test('an unsupported method error falls back to local regions', () => {
  const { session, client } = setup({ documentSymbolProvider: true });
  open(session);
  session.fromClient(query(2, 'documentSymbol'));
  session.fromServer({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'unknown method' } });
  assert.equal(client.at(-1).result[0].name, 'HUD');
});

test('LSP proxy works end-to-end over subprocess stdio and preserves jailsp arguments/env', { timeout: 10000 }, async t => {
  const proxyPath = path.resolve(__dirname, '../resources/jai-region-proxy.cjs');
  const fakeServer = `
    const {MessageReader, encodeMessage} = require(${JSON.stringify(proxyPath)});
    const send = m => process.stdout.write(encodeMessage(m));
    const reader = new MessageReader(m => {
      if (m.method === 'exit') process.exit(0);
      if (m.id === undefined) return;
      let result = null;
      if (m.method === 'initialize') result = {capabilities: {textDocumentSync: 2, documentSymbolProvider: true}};
      else if (m.method === 'textDocument/documentSymbol') result = [${JSON.stringify(symbol)}];
      else if (m.method === 'textDocument/hover') result = {contents: 'jailsp unchanged'};
      else if (m.method === 'test/options') result = {args: process.argv.slice(1), env: process.env.JAI_REGION_TEST};
      send({jsonrpc: '2.0', id: m.id, result});
    });
    process.stdin.on('data', b => reader.push(b));
    process.stdin.on('end', () => process.exit(0));
  `;
  const directory = temporaryWorkDirectory(t);
  const child = spawn(process.execPath, [proxyPath, directory, process.execPath,
    '-e', fakeServer, '--', 'arg with spaces', '界面'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, JAI_REGION_TEST: 'retained' },
  });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  const waiters = new Map();
  const reader = new MessageReader(message => {
    const waiter = waiters.get(message.id);
    if (waiter) { waiters.delete(message.id); waiter(message); }
  });
  child.stdout.on('data', b => reader.push(b));
  const send = message => child.stdin.write(encodeMessage(message));
  const ask = message => new Promise(resolve => { waiters.set(message.id, resolve); send(message); });
  const initialized = await ask(request(1, 'initialize', { capabilities: {
    textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } },
  } }));
  assert.equal(initialized.result.capabilities.foldingRangeProvider, true);
  send(notification('initialized', {}));
  send(notification('textDocument/didOpen', { textDocument: { uri, version: 1, text } }));
  const folded = await ask(query(2, 'foldingRange'));
  assert.ok(folded.result.some(f => f.startLine === 1 && f.endLine === 5));
  const grouped = await ask(query(3, 'documentSymbol'));
  assert.equal(grouped.result[0].children[0].name, 'ui_hud');
  const hover = await ask(query(4, 'hover'));
  assert.equal(hover.result.contents, 'jailsp unchanged');
  const options = await ask(request(5, 'test/options'));
  assert.deepEqual(options.result, { args: ['arg with spaces', '界面'], env: 'retained' });
  await ask(request(6, 'shutdown'));
  const closed = once(child, 'close');
  send(notification('exit', {}));
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  const records = fs.readFileSync(path.join(directory, 'region-proxy.log'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  const exit = records.find(record => record.event === 'server_exit');
  assert.equal(exit.expected, true);
  assert.equal(exit.stopReason, 'client_exit');
  assert.equal(exit.code, 0);
  assert.ok(!records.some(record => record.event === 'proxy_failure'));
  assert.ok(!JSON.stringify(records).includes('ui_hud :: proc'));
});

function temporaryWorkDirectory(t) {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'jai-proxy-lifecycle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function simulateServerExit(t, program) {
  const directory = temporaryWorkDirectory(t);
  const proxyPath = path.resolve(__dirname, '../resources/jai-region-proxy.cjs');
  const child = spawn(process.execPath, [proxyPath, directory, process.execPath, '-e', program], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdout.resume();
  const closed = once(child, 'close');
  child.stdin.write(encodeMessage(request(1, 'initialize', { capabilities: {} })));
  const [code] = await closed;
  const records = fs.readFileSync(path.join(directory, 'region-proxy.log'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  return { code, records, stderr };
}

test('unexpected jailsp exits record their code, stderr, and last request without document text', { timeout: 5000 }, async t => {
  const result = await simulateServerExit(t, `
    process.stdin.once('data', () => {
      process.stderr.write('synthetic jailsp failure\\n');
      process.exit(23);
    });
  `);
  assert.equal(result.code, 23);
  const exit = result.records.find(record => record.event === 'server_exit');
  assert.equal(exit.expected, false);
  assert.equal(exit.code, 23);
  assert.equal(exit.codeHex, '0x17');
  assert.match(exit.stderrTail, /synthetic jailsp failure/);
  assert.deepEqual(exit.recentRequests, [{ direction: 'client', method: 'initialize', id: 1 }]);
  assert.equal(exit.recentRequests[0].params, undefined);
  assert.ok(result.records.some(record => record.event === 'proxy_exit'));
  assert.match(result.stderr, /jailsp exited unexpectedly/);
});

test('malformed upstream frames are recorded as protocol failures with their origin', { timeout: 5000 }, async t => {
  const result = await simulateServerExit(t, `
    process.stdin.once('data', () => process.stdout.write('Invalid-Header: 2\\r\\n\\r\\n{}'));
  `);
  assert.equal(result.code, 1);
  const failure = result.records.find(record => record.event === 'proxy_failure');
  assert.equal(failure.origin, 'server_message');
  assert.match(failure.message, /Invalid LSP Content-Length/);
  assert.ok(failure.stack);
});
