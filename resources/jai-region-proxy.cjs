'use strict';

// Adapted from ctzcs/zed_odin region support; see licenses/odin-extension-MIT.txt.

// Node's standard library only. stdout is reserved for LSP-framed messages.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { analyze, groupSymbols, applyChanges } = require('./regions.cjs');

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

class MessageReader {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
    this.length = null;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.length === null) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (this.buffer.length > 8192) throw new Error('LSP header is too large');
          return;
        }
        const lengths = this.buffer.subarray(0, end).toString('ascii')
          .split('\r\n').filter(line => /^Content-Length:/i.test(line));
        if (lengths.length !== 1 || !/^Content-Length:\s*\d+\s*$/i.test(lengths[0])) {
          throw new Error('Invalid LSP Content-Length header');
        }
        this.length = Number(lengths[0].split(':')[1].trim());
        if (!Number.isSafeInteger(this.length) || this.length > 64 * 1024 * 1024) {
          throw new Error('LSP body is too large');
        }
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.length) return;
      const body = this.buffer.subarray(0, this.length).toString('utf8');
      const message = JSON.parse(body);
      this.buffer = this.buffer.subarray(this.length);
      this.length = null;
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Error('Invalid LSP message');
      }
      this.onMessage(message);
    }
  }

  finish() {
    if (this.length !== null || this.buffer.length) throw new Error('Truncated LSP message');
  }
}

function supports(value) {
  return value !== undefined && value !== null && value !== false;
}

function mergeFolds(upstream, local) {
  const seen = new Set();
  return [...local, ...(Array.isArray(upstream) ? upstream : [])]
    .filter(fold => {
      if (!Number.isInteger(fold.startLine) || !Number.isInteger(fold.endLine)
          || fold.startLine < 0 || fold.endLine <= fold.startLine) return false;
      const key = `${fold.startLine}:${fold.startCharacter ?? ''}:${fold.endLine}:${fold.endCharacter ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}

class ProxySession {
  constructor(toServer, toClient, report = () => {}) {
    this.toServer = toServer;
    this.toClient = toClient;
    this.report = report;
    this.documents = new Map();
    this.pending = new Map();
    this.upstreamFolding = false;
    this.upstreamSymbols = false;
    this.hierarchy = false;
    this.augment = true;
  }

  analysis(document) {
    if (!document.analysis) document.analysis = analyze(document.text);
    return document.analysis;
  }

  response(id, result) {
    this.toClient({ jsonrpc: '2.0', id, result });
  }

  fromClient(message) {
    const params = message.params || {};
    const uri = params.textDocument?.uri;
    if (message.method === 'initialize' && message.id !== undefined) {
      this.hierarchy = params.capabilities?.textDocument?.documentSymbol
        ?.hierarchicalDocumentSymbolSupport === true;
      this.pending.set(message.id, { method: 'initialize' });
      // Local region ranges use UTF-16, which every LSP server must support.
      message = { ...message, params: { ...params, capabilities: {
        ...params.capabilities,
        general: { ...params.capabilities?.general, positionEncjaigs: ['utf-16'] },
      } } };
    } else if (message.method === 'textDocument/didOpen') {
      if (typeof uri === 'string' && typeof params.textDocument.text === 'string') {
        this.documents.set(uri, {
          text: params.textDocument.text, version: params.textDocument.version,
        });
      }
    } else if (message.method === 'textDocument/didChange') {
      const previous = this.documents.get(uri);
      const version = params.textDocument?.version;
      if (previous && Number.isInteger(version) && Number.isInteger(previous.version)
          && version <= previous.version) {
        // Do not roll our cache back for stale/out-of-order changes.
      } else if (Array.isArray(params.contentChanges)) {
        let changes = params.contentChanges;
        if (!previous) {
          const full = changes.findLastIndex(change => change.range == null);
          changes = full < 0 ? [] : changes.slice(full);
        }
        if (previous || changes.length) {
          try {
            const text = applyChanges(previous?.text || '', changes);
            this.documents.set(uri, { text, version });
          } catch (error) {
            this.documents.delete(uri);
            this.report(`Invalid document change; discarding cached ranges: ${error.message}`);
          }
        }
      }
    } else if (message.method === 'textDocument/didClose') {
      this.documents.delete(uri);
    }

    if (this.augment && message.id !== undefined
        && (message.method === 'textDocument/foldingRange'
          || (this.hierarchy && message.method === 'textDocument/documentSymbol'))) {
      const document = this.documents.get(uri);
      const folding = message.method === 'textDocument/foldingRange';
      const upstream = folding ? this.upstreamFolding : this.upstreamSymbols;
      if (!upstream) {
        const data = document ? this.analysis(document) : { regions: [], folds: [] };
        this.response(message.id, folding ? data.folds : groupSymbols([], data.regions, uri));
        return;
      }
      this.pending.set(message.id, { method: message.method, uri, document });
      // Require a complete final result so symbols can be grouped atomically.
      const { partialResultToken, ...forwardedParams } = params;
      message = { ...message, params: forwardedParams };
    }
    this.toServer(message);
  }

  fromServer(message) {
    // IDs are bidirectional: a server request can have the same ID as a client request.
    if (message.method || message.id === undefined) {
      this.toClient(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.toClient(message);
      return;
    }
    this.pending.delete(message.id);
    if (pending.method === 'initialize') {
      if (message.result?.capabilities) {
        const capabilities = message.result.capabilities;
        this.augment = !capabilities.positionEncjaig || capabilities.positionEncjaig === 'utf-16';
        this.upstreamFolding = supports(capabilities.foldingRangeProvider);
        this.upstreamSymbols = supports(capabilities.documentSymbolProvider);
        if (this.augment) {
          message = { ...message, result: { ...message.result, capabilities: {
            ...capabilities,
            foldingRangeProvider: true,
            ...(this.hierarchy ? { documentSymbolProvider: true } : {}),
          } } };
        }
      }
      this.toClient(message);
      return;
    }
    if (pending.document && this.documents.get(pending.uri) !== pending.document) {
      this.toClient({ jsonrpc: '2.0', id: message.id, error: {
        code: -32801, message: 'Document changed while calculating region ranges',
      } });
      return;
    }
    // Preserve genuine jailsp errors and cancellation, but replace unsupported-method errors.
    if (message.error && message.error.code !== -32601) {
      this.toClient(message);
      return;
    }
    if (!pending.document) {
      this.toClient(message);
      return;
    }
    const data = this.analysis(pending.document);
    if (pending.method === 'textDocument/foldingRange') {
      // Prefer jailsp's syntax-aware ordinary folds. Supply our own ordinary
      // folds only if the method is unsupported, avoiding overlapping duplicates.
      const local = message.error ? data.folds : data.folds.filter(fold => fold.kind === 'region');
      this.response(message.id, mergeFolds(message.result, local));
    } else {
      this.response(message.id, groupSymbols(message.result || [], data.regions, pending.uri));
    }
  }
}

function createDiagnostics(workDirectory) {
  const filename = path.join(workDirectory, 'region-proxy.log');
  const write = (event, details = {}) => {
    try {
      // Local, bounded lifecycle diagnostics. Never record LSP params/document text.
      if (fs.existsSync(filename) && fs.statSync(filename).size > 1024 * 1024) {
        fs.writeFileSync(filename, '');
      }
      fs.appendFileSync(filename, `${JSON.stringify({
        time: new Date().toISOString(), pid: process.pid, event, ...details,
      })}\n`);
    } catch {
      // Diagnostics must not make an otherwise healthy language server exit.
    }
  };
  return { filename, write };
}

function main(args) {
  const [workDirectory, binary, ...serverArgs] = args;
  if (!workDirectory || !binary) {
    process.stderr.write('Usage: jai-region-proxy.cjs <extension-work-directory> <jailsp-binary> [args...]\n');
    process.exitCode = 1;
    return;
  }
  const diagnostics = createDiagnostics(workDirectory);
  const recentRequests = [];
  let stopReason = null;
  let failed = false;
  const observe = (direction, message) => {
    if (direction === 'client') {
      if (message.method === 'shutdown') stopReason = 'client_shutdown';
      if (message.method === 'exit') stopReason = 'client_exit';
    }
    if (message.method && message.id !== undefined) {
      recentRequests.push({ direction, method: message.method, id: message.id });
      if (recentRequests.length > 16) recentRequests.shift();
    }
  };
  // Resolve downloaded relative paths against extension work, not the project CWD.
  // Bare custom commands still use PATH, just as the original jailsp launcher did.
  const command = path.isAbsolute(binary) || !/[\\/]/.test(binary)
    ? binary : path.resolve(workDirectory, binary);
  const child = spawn(command, serverArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderrTail = '';
  diagnostics.write('start', { serverPid: child.pid, command });
  const report = text => process.stderr.write(`[jai regions] ${text}\n`);
  const fail = (error, origin = 'proxy') => {
    if (failed) return;
    failed = true;
    diagnostics.write('proxy_failure', {
      origin, message: error.message, stack: error.stack,
      serverPid: child.pid, stopReason, recentRequests, stderrTail,
    });
    report(error.message);
    process.exitCode = 1;
    child.kill();
    process.stdin.destroy();
  };
  const send = (stream, source, message) => {
    if (stream.destroyed) return;
    if (!stream.write(encodeMessage(message))) {
      source.pause();
      stream.once('drain', () => source.resume());
    }
  };
  const session = new ProxySession(
    message => send(child.stdin, process.stdin, message),
    message => send(process.stdout, child.stdout, message),
    text => { diagnostics.write('document_warning', { message: text }); report(text); },
  );
  const clientReader = new MessageReader(message => {
    observe('client', message);
    session.fromClient(message);
  });
  const serverReader = new MessageReader(message => {
    observe('server', message);
    session.fromServer(message);
  });
  const receive = (reader, chunk, origin) => {
    try { reader.push(chunk); } catch (error) { fail(error, origin); }
  };
  process.stdin.on('data', chunk => receive(clientReader, chunk, 'client_message'));
  child.stdout.on('data', chunk => receive(serverReader, chunk, 'server_message'));
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8192);
    if (!process.stderr.destroyed && !process.stderr.write(chunk)) {
      child.stderr.pause();
      process.stderr.once('drain', () => child.stderr.resume());
    }
  });
  process.stdin.on('end', () => {
    stopReason ||= 'client_eof';
    diagnostics.write('client_eof', { stopReason });
    try { clientReader.finish(); } catch (error) { fail(error, 'client_eof'); }
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 2000);
    timeout.unref();
    child.once('exit', () => clearTimeout(timeout));
  });
  child.stdout.on('end', () => {
    try { serverReader.finish(); } catch (error) { fail(error, 'server_eof'); }
  });
  child.on('error', error => fail(error, 'server_process'));
  child.stdin.on('error', error => fail(error, 'server_stdin'));
  child.stdout.on('error', error => fail(error, 'server_stdout'));
  child.stderr.on('error', error => fail(error, 'server_stderr'));
  process.stdin.on('error', error => fail(error, 'client_stdin'));
  process.stdout.on('error', error => fail(error, 'client_stdout'));
  process.stderr.on('error', error => fail(error, 'client_stderr'));
  child.once('close', (code, signal) => {
    diagnostics.write('server_exit', {
      serverPid: child.pid, expected: stopReason !== null,
      stopReason, code, codeHex: code === null ? null : `0x${(code >>> 0).toString(16)}`,
      signal, failed, recentRequests, stderrTail,
    });
    if (!stopReason && !failed) {
      report(`jailsp exited unexpectedly (code=${code}, signal=${signal}); see ${diagnostics.filename}`);
    }
    process.stdin.destroy();
    if (!failed) process.exitCode = code ?? 1;
  });
  // This monitor records crashes but preserves Node's default uncaught-exception behavior.
  process.on('uncaughtExceptionMonitor', error => {
    diagnostics.write('uncaught_exception', {
      message: error.message, stack: error.stack, serverPid: child.pid, recentRequests,
    });
  });
  process.once('exit', code => diagnostics.write('proxy_exit', {
    code, stopReason, failed, serverPid: child.pid,
  }));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      stopReason = signal;
      diagnostics.write('proxy_signal', { signal, serverPid: child.pid });
      child.kill();
      process.stdin.destroy();
    });
  }
}

module.exports = { MessageReader, encodeMessage, ProxySession, mergeFolds };
if (require.main === module) main(process.argv.slice(2));
