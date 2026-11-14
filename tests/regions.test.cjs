'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../resources/regions.cjs');
const { analyze, groupSymbols, applyChanges } = api;
const URI = 'file:///project/main.jai';
const pos = (line, character) => ({ line, character });
const range = (sl, sc, el, ec) => ({ start: pos(sl, sc), end: pos(el, ec) });
const symbol = (name, fullRange, extra = {}) => ({
  name, kind: 12, range: fullRange,
  selectionRange: range(fullRange.start.line, fullRange.start.character,
    fullRange.start.line, fullRange.start.character + 1),
  ...extra,
});
const regionFolds = result => result.folds.filter(fold => fold.kind === 'region');
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('exports exactly the three CommonJS functions', () => {
  assert.deepEqual(Object.keys(api).sort(), ['analyze', 'applyChanges', 'groupSymbols']);
  for (const value of Object.values(api)) assert.equal(typeof value, 'function');
});

test('LF markers trim the title and fold from title EOL through end-marker EOL', () => {
  const result = analyze('  //@region  Work  \nx := 1\n  //@endregion');
  assert.deepEqual(result.regions, [{
    name: 'Work', range: range(0, 2, 2, 14),
    selectionRange: range(0, 13, 0, 17), closed: true,
  }]);
  assert.deepEqual(result.folds, [{
    startLine: 0, startCharacter: 19, endLine: 2, endCharacter: 14, kind: 'region',
  }]);
});

test('CRLF, indentation, spaced markers and Unicode use UTF-16 coordinates', () => {
  const source = '\t// \t@region \t工具 😀 \t\r\nvalue := "😀"\r\n\t// @endregion\t';
  const result = analyze(source);
  const first = source.split('\r\n')[0];
  assert.deepEqual(result.regions[0], {
    name: '工具 😀', range: range(0, 1, 2, 15),
    selectionRange: range(0, first.indexOf('工具'), 0, first.indexOf('工具') + '工具 😀'.length),
    closed: true,
  });
  assert.equal(result.folds[0].startCharacter, first.length);
  assert.equal(result.folds[0].endCharacter, 15);
});

test('only standalone comment markers with nonempty start titles are recognized', () => {
  const source = [
    'x := 0 // @region Inline',
    '//@region', '//@region   \t', '//@regionWrong title',
    '// @endregion trailing title', '///@region Triple',
    '/* comment */ //@region NotStandalone',
    '\u00a0//@region NotSpaceOrTab',
    '// @region Good', 'x := 1 // @endregion',
    '// @endregion wrong', '// @endregion',
  ].join('\n');
  const result = analyze(source);
  assert.deepEqual(result.regions.map(item => [item.name, item.closed]), [['Good', true]]);
  assert.equal(result.regions[0].range.end.line, 11);
});

test('regions pair LIFO, including nested, adjacent and empty regions at EOF', () => {
  const source = [
    '//@region Outer', '//@region Inner', '//@endregion', '//@endregion',
    '//@region Adjacent', '//@endregion',
  ].join('\n');
  const result = analyze(source);
  assert.deepEqual(result.regions.map(item => [item.name, item.range.start.line, item.range.end.line, item.closed]), [
    ['Outer', 0, 3, true], ['Inner', 1, 2, true], ['Adjacent', 4, 5, true],
  ]);
  assert.equal(regionFolds(result).length, 3);
  assert.equal(result.folds[2].endCharacter, '//@endregion'.length);
});

test('orphan ends are ignored and unclosed starts stay single-line navigation entries', () => {
  const result = analyze('//@endregion\n//@region Lost\nx := 1\n//@region Last');
  assert.deepEqual(result.regions.map(item => [item.name, item.closed, item.range]), [
    ['Lost', false, range(1, 0, 1, 14)], ['Last', false, range(3, 0, 3, 14)],
  ]);
  assert.deepEqual(result.folds, []);
});

test('an end in a proc cannot close an outer region, nor can an inner start escape it', () => {
  const result = analyze([
    '//@region Outer', 'p :: proc() {', '  //@endregion',
    '  //@region Inner', '}', '//@endregion',
  ].join('\n'));
  assert.deepEqual(result.regions.map(item => [item.name, item.closed, item.range.end.line]), [
    ['Outer', true, 5], ['Inner', false, 3],
  ]);
  assert.equal(regionFolds(result).length, 1);
  assert.ok(result.folds.some(item => item.startLine === 1 && item.endLine === 4));
});

test('different sibling scopes at the same depth cannot pair markers', () => {
  const result = analyze('a :: proc() {\n //@region Lost\n}\nb :: proc() {\n //@endregion\n}\n//@endregion');
  assert.equal(result.regions.length, 1);
  assert.equal(result.regions[0].closed, false);
  assert.equal(result.regions[0].range.end.line, 1);
  assert.equal(regionFolds(result).length, 0);
});

test('brace, bracket and parenthesis scopes each isolate pending regions', () => {
  for (const [open, close] of [['{', '}'], ['[', ']'], ['(', ')']]) {
    const result = analyze(`${open}\n //@region Lost\n${close}\n//@endregion`);
    assert.equal(result.regions[0].closed, false, open);
    assert.equal(result.folds.length, 1, open);
    assert.equal(result.folds[0].kind, undefined);
  }
});

test('mismatched code delimiters discard abandoned inner region stacks safely', () => {
  const result = analyze('{\n(\n//@region Lost\n}\n//@endregion');
  assert.equal(result.regions[0].closed, false);
  assert.equal(result.regions[0].range.end.line, 2);
  assert.equal(regionFolds(result).length, 0);
});

test('escaped ordinary strings and character literals do not affect markers or scopes', () => {
  const source = [
    '//@region Real',
    String.raw`text := "escaped \" // @endregion { [ ("`,
    String.raw`slash := #char "\\"; apostrophe := #char "'"; brace := #char "}"`,
    'text2 := "//@region Fake"',
    '//@endregion',
  ].join('\n');
  const result = analyze(source);
  assert.deepEqual(result.regions.map(item => [item.name, item.closed]), [['Real', true]]);
  assert.equal(result.folds.length, 1);
});

test('nested block comments ignore markers and keep outer and nested comment folds', () => {
  const result = analyze([
    '/* outer', '//@region Fake', '  /* nested', '//@endregion', '  */', '*/',
    '//@region Real', '//@endregion',
  ].join('\n'));
  assert.deepEqual(result.regions.map(item => item.name), ['Real']);
  assert.deepEqual(result.folds.filter(item => item.kind === 'comment'), [
    { startLine: 0, startCharacter: 2, endLine: 5, endCharacter: 0, kind: 'comment' },
    { startLine: 2, startCharacter: 4, endLine: 4, endCharacter: 2, kind: 'comment' },
  ]);
});

test('Jai here-strings ignore markers, nested comments and quotes until a whole terminator', () => {
  for (const header of ['#string END', '#string,cr END', '#string,\\%,cr END',
    '# string /* nested /* comment */ */ , cr\n// header comment\nEND']) {
    const result = analyze([
      `text :: ${header}`, '//@region Fake', 'END_extra',
      '/* " \' { [ (', '//@endregion', '  END;',
      '//@region Real', '//@endregion',
    ].join('\n'));
    assert.deepEqual(result.regions.map(item => [item.name, item.closed]), [['Real', true]], header);
    assert.equal(regionFolds(result).length, 1);
    assert.equal(result.folds.length, 2);
  }
});

test('unfinished here-strings, including later-line tags, stay opaque', () => {
  for (const header of ['#string END', '#string,cr END', '#string\n/* comment */\nEND']) {
    assert.deepEqual(analyze(`${header}\n//@region Fake\n//@endregion`).regions, []);
  }
});

test('Jai numeric separators and backticks do not start strings', () => {
  const result = analyze('number := 1\'000;\n`name;\n//@region Real\n//@endregion');
  assert.equal(result.regions[0].closed, true);
});

test('here-string terminators allow trailing Jai code and Unicode tags', () => {
  const result = analyze('text :: #string 结束\r\n//@region Fake\r\n结束; {\r\n//@region Real\r\n//@endregion\r\n}');
  assert.deepEqual(result.regions.map(item => [item.name, item.closed]), [['Real', true]]);
  assert.ok(result.folds.some(f => f.startLine === 2 && f.endLine === 5));
});

test('unfinished lexical constructs never expose fake marker lines or speculative folds', () => {
  for (const start of ['/*', '#string END', '"']) {
    const result = analyze(`${start}\n//@region Fake\n//@endregion\n{\n}`);
    assert.deepEqual(result.regions, [], start);
    assert.deepEqual(result.folds, [], start);
  }
});

test('multiline braces, brackets and parentheses fold even without regions', () => {
  const result = analyze('p :: proc(\n x: int,\n) {\n values := [3]int{\n  1, 2, 3,\n }\n items := [\n  1,\n ]\n}');
  assert.deepEqual(result.regions, []);
  assert.deepEqual(result.folds, [
    { startLine: 0, startCharacter: 10, endLine: 2, endCharacter: 0 },
    { startLine: 2, startCharacter: 3, endLine: 9, endCharacter: 0 },
    { startLine: 3, startCharacter: 18, endLine: 5, endCharacter: 1 },
    { startLine: 6, startCharacter: 11, endLine: 8, endCharacter: 1 },
  ]);
});

test('delimiter folds preserve the closing delimiter and use CRLF/UTF-16 character columns', () => {
  const source = 'p := "😀"; {\r\n  x := 1\r\n  } tail';
  const result = analyze(source);
  assert.deepEqual(result.folds, [{
    startLine: 0, startCharacter: 'p := "😀"; {'.length, endLine: 2, endCharacter: 2,
  }]);
});

test('same-line constructs, strings and line comments never create ordinary folds', () => {
  const result = analyze('p :: proc() { x := [1]int{2} }\n// { [ ( /* `\ns := "{ [ ("\nc := \'}\'\n/* same line */\nraw := `same line`');
  assert.deepEqual(result.folds, []);
});

test('ordinary folds remain nested alongside regions and do not duplicate ranges', () => {
  const result = analyze('p :: proc() {\n //@region R\n if ok {\n  /* outer\n   /* inner\n   */\n  */\n }\n //@endregion\n}');
  assert.equal(result.folds.length, 5);
  assert.equal(regionFolds(result).length, 1);
  assert.equal(new Set(result.folds.map(item => [item.startLine, item.startCharacter, item.endLine, item.endCharacter].join(':'))).size, 5);
});

test('the empty document, final newline, and CR-only line endings are safe', () => {
  assert.deepEqual(analyze(''), { regions: [], folds: [] });
  for (const newline of ['\n', '\r\n', '\r']) {
    const result = analyze(`//@region R${newline}//@endregion${newline}`);
    assert.equal(result.regions[0].range.end.line, 1);
    assert.equal(result.folds.length, 1);
  }
});

test('without regions both hierarchical and flat symbol arrays are returned unchanged', () => {
  const hierarchical = freeze([symbol('p', range(0, 0, 2, 1), { children: [] })]);
  const flat = freeze([{ name: 'foreign', kind: 12, location: { uri: 'file:///other.jai', range: range(1, 0, 1, 2) } }]);
  assert.equal(groupSymbols(hierarchical, [], URI), hierarchical);
  assert.equal(groupSymbols(flat, [], URI), flat);
});

test('an outer region wraps a whole proc and preserves OLS metadata and existing children', () => {
  const { regions } = analyze('//@region API\np :: proc() {\n x := 1\n}\n//@endregion');
  const child = symbol('x', range(2, 1, 2, 7), { kind: 13 });
  const input = freeze([symbol('OLS name', range(1, 0, 3, 1), {
    kind: 12, detail: 'proc() -> int', tags: [1], deprecated: true, children: [child],
  })]);
  freeze(regions);
  const output = groupSymbols(input, regions, URI);
  assert.equal(output[0].name, 'API');
  assert.equal(output[0].kind, 2);
  assert.deepEqual(output[0].selectionRange, regions[0].selectionRange);
  assert.deepEqual(output[0].children, input);
  assert.equal(input[0].children[0], child);
});

test('a region inside a proc is inserted into proc.children rather than at the document root', () => {
  const { regions } = analyze('p :: proc() {\n //@region Locals\n a := 1\n //@endregion\n b := 2\n}');
  const a = symbol('a', range(2, 1, 2, 7));
  const b = symbol('b', range(4, 1, 4, 7));
  const output = groupSymbols([symbol('p', range(0, 0, 5, 1), { children: [a, b] })], regions, URI);
  assert.deepEqual(output.map(item => item.name), ['p']);
  assert.deepEqual(output[0].children.map(item => item.name), ['Locals', 'b']);
  assert.deepEqual(output[0].children[0].children, [a]);
});

test('nested regions work both outside and inside an existing symbol hierarchy', () => {
  const { regions } = analyze([
    '//@region API', 'p :: proc() {', ' //@region Body', ' //@region Values',
    ' x := 1', ' //@endregion', ' //@endregion', '}', '//@endregion',
  ].join('\n'));
  const x = symbol('x', range(4, 1, 4, 7));
  const input = freeze([symbol('p', range(1, 0, 7, 1), { children: [x] })]);
  const output = groupSymbols(input, freeze(regions), URI);
  assert.equal(output[0].name, 'API');
  const proc = output[0].children[0];
  assert.equal(proc.name, 'p');
  assert.equal(proc.children[0].name, 'Body');
  assert.equal(proc.children[0].children[0].name, 'Values');
  assert.deepEqual(proc.children[0].children[0].children, [x]);
});

test('symbols whose full range crosses a region boundary are not wrapped', () => {
  const { regions } = analyze('//@region R\nx\n//@endregion\ntail');
  const crossing = symbol('crossing', range(1, 0, 3, 4), { detail: 'keep full range' });
  const fits = symbol('fits', range(1, 0, 1, 1));
  const output = groupSymbols([crossing, fits], regions, URI);
  assert.deepEqual(output.map(item => item.name), ['R', 'crossing']);
  assert.deepEqual(output[0].children, [fits]);
  assert.deepEqual(output[1], crossing);
});

test('an unfinished region cannot wrap the rest of a proc or file', () => {
  const { regions } = analyze('p :: proc() {\n //@region Lost\n x := 1\n}\ny := 2');
  const x = symbol('x', range(2, 1, 2, 7));
  const y = symbol('y', range(4, 0, 4, 6));
  const output = groupSymbols([symbol('p', range(0, 0, 3, 1), { children: [x] }), y], regions, URI);
  assert.deepEqual(output.map(item => item.name), ['p', 'y']);
  assert.deepEqual(output[0].children.map(item => item.name), ['Lost', 'x']);
  assert.deepEqual(output[0].children[0].children, []);
  assert.deepEqual(output[0].children[0].range, range(1, 1, 1, 15));
});

test('flat SymbolInformation becomes hierarchical DocumentSymbol and foreign URIs are excluded', () => {
  const { regions } = analyze('//@region API\np :: proc() {\n //@region Body\n x := 1\n //@endregion\n}\n//@endregion');
  const info = (name, fullRange, extra = {}) => ({
    name, kind: 12, location: { uri: URI, range: fullRange }, containerName: 'ambiguous', ...extra,
  });
  const input = freeze([
    info('x', range(3, 1, 3, 7), { kind: 13, tags: [1], detail: 'int' }),
    info('foreign', range(3, 1, 3, 7), { location: { uri: 'file:///other.jai', range: range(3, 1, 3, 7) } }),
    info('p', range(1, 0, 5, 1)),
  ]);
  const output = groupSymbols(input, regions, URI);
  const proc = output[0].children[0];
  assert.equal(proc.name, 'p');
  assert.equal(proc.children[0].name, 'Body');
  assert.deepEqual(proc.children[0].children, [{
    name: 'x', kind: 13, tags: [1], detail: 'int', range: range(3, 1, 3, 7),
    selectionRange: range(3, 1, 3, 7),
  }]);
  assert.equal(proc.location, undefined);
  assert.equal(proc.containerName, undefined);
  assert.deepEqual(proc.selectionRange, range(1, 0, 5, 1));
});

test('flat range containment chooses the narrowest enclosing symbol, not containerName', () => {
  const { regions } = analyze('p :: proc() {\n if ok {\n //@region Inner\n x := 1\n //@endregion\n }\n}');
  const info = (name, fullRange) => ({ name, kind: 12, location: { uri: URI, range: fullRange }, containerName: 'wrong' });
  const output = groupSymbols([
    info('x', range(3, 1, 3, 7)), info('p', range(0, 0, 6, 1)), info('if', range(1, 1, 5, 2)),
  ], regions, URI);
  assert.equal(output[0].children[0].name, 'if');
  assert.equal(output[0].children[0].children[0].name, 'Inner');
  assert.equal(output[0].children[0].children[0].children[0].name, 'x');
});

test('an empty region is still a selectable module with an empty children array', () => {
  const { regions } = analyze('//@region Empty\n//@endregion');
  assert.deepEqual(groupSymbols([], regions, URI), [{
    name: 'Empty', kind: 2, range: regions[0].range, selectionRange: regions[0].selectionRange, children: [],
  }]);
});

test('equal symbol/region ranges and duplicate externally supplied region ranges cannot cycle', () => {
  const { regions } = analyze('//@region R\n//@endregion');
  const output = groupSymbols([symbol('same', regions[0].range)], [regions[0], { ...regions[0], name: 'Duplicate' }], URI);
  assert.equal(output[0].name, 'R');
  assert.equal(output[0].children[0].name, 'Duplicate');
  assert.equal(output[0].children[0].children[0].name, 'same');
});

test('source ordering integrates adjacent regions without losing existing symbol children', () => {
  const { regions } = analyze('before\n//@region A\nx\n//@endregion\n//@region B\ny\n//@endregion\nafter');
  const output = groupSymbols([
    symbol('after', range(7, 0, 7, 5)), symbol('y', range(5, 0, 5, 1), { children: [] }),
    symbol('before', range(0, 0, 0, 6)), symbol('x', range(2, 0, 2, 1)),
  ], regions, URI);
  assert.deepEqual(output.map(item => item.name), ['before', 'A', 'B', 'after']);
  assert.deepEqual(output[2].children[0].children, []);
});

test('full changes, empty changes and sequential full replacement are supported', () => {
  assert.equal(applyChanges('old', []), 'old');
  assert.equal(applyChanges('old', [{ text: 'new' }, { text: '' }]), '');
});

test('incremental edits are applied sequentially against each updated document', () => {
  const result = applyChanges('abc\ndef', [
    { range: range(0, 1, 0, 2), text: 'B\nC' },
    { range: range(1, 1, 2, 1), text: '!' },
  ]);
  assert.equal(result, 'aB\nC!ef');
});

test('incremental UTF-16 and CRLF edits preserve untouched line endings', () => {
  const result = applyChanges('a😀b\r\n工具\r\nlast', [
    { range: range(0, 1, 0, 3), rangeLength: 2, text: '🚀' },
    { range: range(0, 4, 1, 1), rangeLength: 3, text: '!\r\n新' },
  ]);
  assert.equal(result, 'a🚀b!\r\n新具\r\nlast');
});

test('full replacement can precede incremental changes in the same notification', () => {
  assert.equal(applyChanges('old', [
    { text: 'a\r\nb' }, { range: range(1, 0, 1, 1), text: 'B' },
  ]), 'a\r\nB');
});

test('incremental insertion supports EOF, the final empty line and an empty document', () => {
  assert.equal(applyChanges('', [{ range: range(0, 0, 0, 0), text: '😀' }]), '😀');
  assert.equal(applyChanges('a\n', [{ range: range(1, 0, 1, 0), text: 'b' }]), 'a\nb');
  assert.equal(applyChanges('a', [{ range: range(0, 1, 0, 1), text: '!' }]), 'a!');
});

test('multiline deletion counts both CRLF code units in rangeLength', () => {
  assert.equal(applyChanges('a\r\nb', [{ range: range(0, 1, 1, 0), rangeLength: 2, text: '' }]), 'ab');
});

test('malformed, negative, fractional, past-EOL and reversed ranges throw rather than clamp', () => {
  const invalid = [
    null, 1, 'bad', {}, { start: pos(0, 0) }, range(-1, 0, 0, 0), range(0, -1, 0, 0),
    range(0.5, 0, 1, 0), range(0, 0.5, 1, 0), range(0, 0, 2, 0),
    range(0, 0, 0, 4), range(1, 0, 0, 0), range(0, 2, 0, 1),
    { start: pos(NaN, 0), end: pos(0, 0) },
    { start: pos(0, 0), end: pos(0, Infinity) },
  ];
  for (const bad of invalid) {
    assert.throws(() => applyChanges('abc\r\nx', [{ range: bad, text: '' }]), RangeError, JSON.stringify(bad));
  }
  assert.throws(() => applyChanges('a\r\nb', [{ range: range(0, 2, 1, 0), text: '' }]), RangeError);
});

test('rangeLength mismatches and invalid change payloads throw', () => {
  for (const rangeLength of [-1, 1.5, 0, '1']) {
    assert.throws(() => applyChanges('x', [{ range: range(0, 0, 0, 1), rangeLength, text: '' }]), RangeError);
  }
  assert.equal(applyChanges('x', [{ range: range(0, 0, 0, 0), rangeLength: 0, text: '' }]), 'x');
  for (const changes of [[null], [{}], [{ text: 1 }], null]) {
    assert.throws(() => applyChanges('x', changes), TypeError);
  }
});

test('incremental edits produce fresh analysis of Unicode titles and paired markers', () => {
  const original = '//@region Old\r\nx := 1\r\n//@endregion';
  const edited = applyChanges(original, [{ range: range(0, 10, 0, 13), text: '工具 😀' }]);
  const result = analyze(edited);
  assert.equal(result.regions[0].name, '工具 😀');
  assert.deepEqual(result.regions[0].selectionRange, range(0, 10, 0, 15));
  assert.equal(result.folds[0].startCharacter, 15);
  assert.equal(result.regions[0].closed, true);
});

test('regions add children to a hierarchical proc that did not originally have children', () => {
  const { regions } = analyze('p :: proc() {\n //@region Empty\n //@endregion\n}');
  const input = freeze([symbol('p', range(0, 0, 3, 1))]);
  const output = groupSymbols(input, regions, URI);
  assert.equal(output[0].children[0].name, 'Empty');
  assert.deepEqual(output[0].children[0].children, []);
  assert.equal(input[0].children, undefined);
});

test('an unclosed outer start does not prevent an inner matched region from folding', () => {
  const result = analyze('//@region Lost\n//@region Matched\nx\n//@endregion\ntail');
  assert.deepEqual(result.regions.map(item => [item.name, item.closed]), [['Lost', false], ['Matched', true]]);
  assert.equal(regionFolds(result).length, 1);
  const output = groupSymbols([symbol('x', range(2, 0, 2, 1)), symbol('tail', range(4, 0, 4, 4))], result.regions, URI);
  assert.deepEqual(output.map(item => item.name), ['Lost', 'Matched', 'tail']);
  assert.equal(output[1].children[0].name, 'x');
});

test('the first bad edit throws even when a later change would fully replace the text', () => {
  assert.throws(() => applyChanges('old', [
    { range: range(99, 0, 99, 0), text: '' }, { text: 'replacement' },
  ]), RangeError);
});

test('flat symbols with equal ranges remain separate and preserve selection overrides', () => {
  const { regions } = analyze('//@region R\nx\n//@endregion');
  const fullRange = range(1, 0, 1, 1);
  const input = freeze(['a', 'b'].map(name => ({
    name, kind: 13, location: { uri: URI, range: fullRange }, selectionRange: range(1, 0, 1, 0),
  })));
  const output = groupSymbols(input, regions, URI);
  assert.deepEqual(output[0].children.map(item => item.name), ['a', 'b']);
  assert.deepEqual(output[0].children[0].selectionRange, range(1, 0, 1, 0));
});
