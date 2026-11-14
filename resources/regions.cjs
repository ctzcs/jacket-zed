'use strict';

// Adapted from ctzcs/zed_odin region support; see licenses/odin-extension-MIT.txt.

// JavaScript indices are UTF-16 code units, as required by the LSP default encoding.
function linesOf(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\n' && text[i] !== '\r') continue;
    lines.push({ start, end: i });
    if (text[i] === '\r' && text[i + 1] === '\n') i += 1;
    start = i + 1;
  }
  lines.push({ start, end: text.length });
  return lines;
}

function comparePosition(a, b) {
  return a.line - b.line || a.character - b.character;
}

function contains(outer, inner) {
  return comparePosition(outer.start, inner.start) <= 0
    && comparePosition(outer.end, inner.end) >= 0;
}

function sameRange(a, b) {
  return comparePosition(a.start, b.start) === 0 && comparePosition(a.end, b.end) === 0;
}

function rangeOrder(a, b) {
  return comparePosition(a.start, b.start) || comparePosition(b.end, a.end);
}

const identifierChar = ch => ch !== undefined && /[A-Za-z0-9_\u0080-\uffff]/.test(ch);

// Jai #string headers allow flags and comments before a terminator on a later
// line. Bodies end at that word at the start of a line (after indentation).
function hereString(text, at) {
  function gap() {
    for (;;) {
      if (/[ \t\r\n]/.test(text[at] || '\0')) at += 1;
      else if (text.startsWith('//', at)) {
        while (at < text.length && text[at] !== '\n') at += 1;
      } else if (text.startsWith('/*', at)) {
        let depth = 1;
        at += 2;
        while (at < text.length && depth) {
          if (text.startsWith('/*', at)) { depth += 1; at += 2; }
          else if (text.startsWith('*/', at)) { depth -= 1; at += 2; }
          else at += 1;
        }
      } else return;
    }
  }
  function word() {
    const start = at;
    while (identifierChar(text[at])) at += 1;
    return text.slice(start, at);
  }
  gap();
  while (text[at] === ',') {
    at += 1;
    gap();
    if (text[at] === '\\') at = Math.min(at + 2, text.length);
    else if (!word()) return { end: text.length };
    gap();
  }
  const tag = word();
  if (!tag) return { end: text.length };
  while (at < text.length && text[at] !== '\n' && text[at] !== '\r') at += 1;
  while (at < text.length) {
    if (text[at] === '\r') at += 1;
    if (text[at] === '\n') at += 1;
    while (text[at] === ' ' || text[at] === '\t') at += 1;
    if (text.startsWith(tag, at) && !identifierChar(text[at + tag.length])) {
      return { end: at + tag.length, close: at };
    }
    while (at < text.length && text[at] !== '\n' && text[at] !== '\r') at += 1;
  }
  return { end: text.length };
}

function analyze(text) {
  if (typeof text !== 'string') throw new TypeError('Document text must be a string');
  const lines = linesOf(text);
  const regions = [];
  const folds = [];
  const foldKeys = new Set();
  const scopes = [{ opener: '', regions: [] }];
  const comments = [];
  let quote = null;
  let opaqueUntil = 0;

  function positionAt(offset) {
    let lo = 0, hi = lines.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (lines[mid].start <= offset) lo = mid;
      else hi = mid;
    }
    return { line: lo, character: offset - lines[lo].start };
  }

  function fold(start, end, kind) {
    if (end.line <= start.line) return;
    const key = `${start.line}:${start.character}:${end.line}:${end.character}`;
    if (foldKeys.has(key)) return;
    foldKeys.add(key);
    const result = {
      startLine: start.line,
      startCharacter: start.character,
      endLine: end.line,
      endCharacter: end.character,
    };
    if (kind) result.kind = kind;
    folds.push(result);
  }

  function marker(lineNumber, commentStart) {
    const line = lines[lineNumber];
    if (!/^[ \t]*$/.test(text.slice(line.start, commentStart))) return;
    const body = text.slice(commentStart + 2, line.end);
    const scope = scopes[scopes.length - 1];
    const prefix = /^[ \t]*@region[ \t]+/.exec(body);
    if (prefix) {
      const title = body.slice(prefix[0].length);
      const name = title.trim();
      if (!name) return;
      const character = commentStart + 2 + prefix[0].length
        + title.length - title.trimStart().length - line.start;
      const region = {
        name,
        range: {
          start: { line: lineNumber, character: commentStart - line.start },
          end: { line: lineNumber, character: line.end - line.start },
        },
        selectionRange: {
          start: { line: lineNumber, character },
          end: { line: lineNumber, character: character + name.length },
        },
        closed: false,
      };
      regions.push(region);
      scope.regions.push(region);
    } else if (/^[ \t]*@endregion[ \t]*$/.test(body) && scope.regions.length) {
      const region = scope.regions.pop();
      region.closed = true;
      region.range.end = { line: lineNumber, character: line.end - line.start };
      const firstLine = lines[region.range.start.line];
      fold(
        { line: region.range.start.line, character: firstLine.end - firstLine.start },
        region.range.end,
        'region',
      );
    }
  }

  // Scope-local region stacks prevent a start in a proc (or bracket expression)
  // from consuming an end after that scope has closed. Unmatched starts already
  // have a safe, single-line navigation range and never produce a fold.
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    for (let i = line.start; i < line.end;) {
      if (i < opaqueUntil) { i = Math.min(line.end, opaqueUntil); continue; }
      const ch = text[i];
      const next = text[i + 1];
      const position = { line: lineNumber, character: i - line.start };
      if (comments.length) {
        if (ch === '/' && next === '*') {
          comments.push({ line: lineNumber, character: position.character + 2 });
          i += 2;
        } else if (ch === '*' && next === '/') {
          fold(comments.pop(), position, 'comment');
          i += 2;
        } else {
          i += 1;
        }
      } else if (quote) {
        if (ch === '\\') i += 2;
        else {
          if (ch === quote) quote = null;
          i += 1;
        }
      } else if (ch === '/' && next === '/') {
        marker(lineNumber, i);
        break;
      } else if (ch === '/' && next === '*') {
        comments.push({ line: lineNumber, character: position.character + 2 });
        i += 2;
      } else if (ch === '#' && /^#[ \t]*string(?![A-Za-z0-9_\u0080-\uffff])/.test(text.slice(i))) {
        const directive = /^#[ \t]*string/.exec(text.slice(i))[0];
        const literal = hereString(text, i + directive.length);
        opaqueUntil = literal.end;
        if (literal.close !== undefined) fold(positionAt(line.end), positionAt(literal.close));
        i = Math.min(line.end, opaqueUntil);
      } else if (ch === '"') {
        quote = ch;
        i += 1;
      } else if ('{[('.includes(ch)) {
        scopes.push({ opener: ch, position, regions: [] });
        i += 1;
      } else if ('}])'.includes(ch)) {
        const opener = { '}': '{', ']': '[', ')': '(' }[ch];
        let match = scopes.length - 1;
        while (match > 0 && scopes[match].opener !== opener) match -= 1;
        if (match > 0) {
          const opening = scopes[match].position;
          fold({ line: opening.line, character: opening.character + 1 }, position);
          // Discard any malformed inner scopes as well as the matched scope.
          scopes.length = match;
        }
        i += 1;
      } else {
        i += 1;
      }
    }
  }

  folds.sort((a, b) => a.startLine - b.startLine || a.startCharacter - b.startCharacter
    || b.endLine - a.endLine || b.endCharacter - a.endCharacter);
  return { regions, folds };
}

function groupSymbols(symbols, regions, uri) {
  // In particular, do not convert a flat server response when no regions exist.
  if (!regions.length) return symbols;

  function normalize(symbol) {
    const flat = !symbol.range && symbol.location && symbol.location.range;
    if (flat && symbol.location.uri !== uri) return null;
    let value;
    if (flat) {
      const { location, containerName, ...rest } = symbol;
      value = { ...rest, range: location.range, selectionRange: symbol.selectionRange || location.range };
    } else {
      value = { ...symbol };
    }
    return {
      value,
      range: value.range,
      flat: Boolean(flat),
      hadChildren: Array.isArray(symbol.children),
      children: (symbol.children || []).map(normalize).filter(Boolean),
    };
  }

  const initial = symbols.map(normalize).filter(Boolean);
  const parents = new Map();
  // SymbolInformation has no children. Recover its hierarchy by full range,
  // never by containerName (which is ambiguous for overloads and nested scopes).
  for (const node of initial) {
    if (!node.flat) continue;
    let parent = null;
    for (const candidate of initial) {
      if (candidate === node || !contains(candidate.range, node.range)
        || sameRange(candidate.range, node.range)) continue;
      if (!parent || rangeOrder(candidate.range, parent.range) > 0) parent = candidate;
    }
    if (parent) parents.set(node, parent);
  }
  for (const [node, parent] of parents) parent.children.push(node);
  const roots = initial.filter(node => !parents.has(node));
  const all = [];
  function collect(nodes, depth) {
    for (const node of nodes) {
      node.depth = depth;
      all.push(node);
      collect(node.children, depth + 1);
    }
  }
  collect(roots, 0);

  const assigned = new Map();
  const rootRegions = [];
  for (const region of regions) {
    let owner = null;
    for (const symbol of all) {
      // Equal ranges belong below the region, avoiding symbol/region cycles.
      if (!contains(symbol.range, region.range) || sameRange(symbol.range, region.range)) continue;
      if (!owner || symbol.depth > owner.depth
        || (symbol.depth === owner.depth && rangeOrder(symbol.range, owner.range) > 0)) owner = symbol;
    }
    const node = { region, range: region.range };
    if (owner) {
      if (!assigned.has(owner)) assigned.set(owner, []);
      assigned.get(owner).push(node);
    } else {
      rootRegions.push(node);
    }
  }

  function renderContainer(symbolNodes, regionNodes) {
    const entries = [...symbolNodes, ...regionNodes];
    const children = new Map(regionNodes.map(node => [node, []]));
    const top = [];
    for (const entry of entries) {
      let parent = null;
      for (let i = 0; i < regionNodes.length; i += 1) {
        const candidate = regionNodes[i];
        if (candidate === entry || !candidate.region.closed || !contains(candidate.range, entry.range)) continue;
        // Stable ordering also makes duplicate externally supplied ranges safe.
        if (sameRange(candidate.range, entry.range) && entry.region
          && i > regionNodes.indexOf(entry)) continue;
        if (!parent || rangeOrder(candidate.range, parent.range) >= 0) parent = candidate;
      }
      if (parent) children.get(parent).push(entry);
      else top.push(entry);
    }

    function render(entry) {
      if (entry.region) {
        return {
          name: entry.region.name,
          kind: 2, // SymbolKind.Module
          range: entry.region.range,
          selectionRange: entry.region.selectionRange,
          children: ordered(children.get(entry)),
        };
      }
      const nested = renderContainer(entry.children, assigned.get(entry) || []);
      const value = { ...entry.value };
      if (entry.hadChildren || nested.length) value.children = nested;
      return value;
    }
    function ordered(nodes) {
      return nodes.slice().sort((a, b) => rangeOrder(a.range, b.range)).map(render);
    }
    return ordered(top);
  }

  return renderContainer(roots, rootRegions);
}

function applyChanges(text, contentChanges) {
  if (typeof text !== 'string' || !Array.isArray(contentChanges)) {
    throw new TypeError('Expected document text and an array of content changes');
  }
  for (const change of contentChanges) {
    if (!change || typeof change.text !== 'string') throw new TypeError('Change text must be a string');
    if (change.range === undefined) {
      text = change.text;
      continue;
    }
    if (!change.range || typeof change.range !== 'object') throw new RangeError('Invalid LSP range');
    const lines = linesOf(text);
    function offset(position) {
      if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character)
        || position.line < 0 || position.line >= lines.length || position.character < 0) {
        throw new RangeError('Invalid LSP position');
      }
      const line = lines[position.line];
      if (position.character > line.end - line.start) throw new RangeError('LSP position exceeds line length');
      return line.start + position.character;
    }
    const start = offset(change.range.start);
    const end = offset(change.range.end);
    if (start > end) throw new RangeError('Reversed LSP range');
    if (change.rangeLength !== undefined
      && (!Number.isInteger(change.rangeLength) || change.rangeLength !== end - start)) {
      throw new RangeError('rangeLength does not match the UTF-16 range');
    }
    text = text.slice(0, start) + change.text + text.slice(end);
  }
  return text;
}

module.exports = { analyze, groupSymbols, applyChanges };
