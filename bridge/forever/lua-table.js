'use strict';
class LuaParseError extends Error { constructor(message, truncated = false) { super(message); this.name = 'LuaParseError'; this.truncated = truncated; } }
function parse(src) {
  let i = 0;
  const fail = (msg, trunc = i >= src.length) => { throw new LuaParseError(msg, trunc); };
  const ws = () => {
    for (;;) {
      while (/\s/.test(src[i] || '') && i < src.length) i++;
      if (src.slice(i, i + 2) === '--') { while (i < src.length && src[i] !== '\n') i++; continue; }
      break;
    }
  };
  const expect = c => { ws(); if (src[i] !== c) fail(`expected ${c}`); i++; };
  function string() {
    expect('"'); let out = '';
    while (i < src.length && src[i] !== '"') {
    if (src[i] !== '\\') { out += src[i++]; continue; }
      i++; if (i >= src.length) fail('truncated escape', true);
      const c = src[i++];
      if (c === 'n') out += '\n'; else if (c === 'r') out += '\r'; else if (c === 't') out += '\t';
      else if (/[0-9]/.test(c)) {
        let digits = c;
        while (digits.length < 3 && /[0-9]/.test(src[i] || '')) digits += src[i++];
        out += String.fromCharCode(Number(digits));
      }
      else out += c;
    }
    if (src[i] !== '"') fail('truncated string', true);
    i++; return out;
  }
  function value() {
    ws();
    if (src[i] === '{') return table();
    if (src[i] === '"') return string();
    const rest = src.slice(i);
    const num = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (num) { i += num[0].length; return Number(num[0]); }
    const word = /^[A-Za-z_][\w]*/.exec(rest);
    if (word) {
      i += word[0].length;
      if (word[0] === 'true') return true;
      if (word[0] === 'false') return false;
      if (word[0] === 'nil') return null;
      fail('unsupported identifier');
    }
    fail('expected value');
  }
  function table() {
    expect('{'); const obj = {}; let index = 1;
    for (;;) {
      ws(); if (src[i] === '}') { i++; break; }
      if (i >= src.length) fail('truncated table', true);
      let key, explicit = false;
      if (src[i] === '[') {
        i++;
        key = value();
        expect(']');
        expect('=');
        explicit = true;
      }
      else {
        const id = /^[A-Za-z_][\w]*/.exec(src.slice(i));
        if (id) { const end = i + id[0].length; let j = end; while (/\s/.test(src[j] || '') && j < src.length) j++;
          if (src[j] === '=') { key = id[0]; i = j + 1; explicit = true; } }
      }
      if (!explicit) key = index++;
      const v = value(); ws();
      // Our SavedVariables never use __proto__; assigning it would swap the object's prototype.
      if (key !== '__proto__') obj[key] = v;
      if (src[i] === ',') { i++; continue; }
      if (src[i] === ';') { i++; continue; }
      if (src[i] !== '}') fail('expected comma or }');
    }
    const keys = Object.keys(obj).map(Number).sort((a, b) => a - b);
    if (keys.length && keys.every((n, j) => Number.isInteger(n) && n === j + 1) && Object.keys(obj).length === keys.length) return keys.map(n => obj[n]);
    return obj;
  }
  ws(); const result = value(); ws(); return result;
}
function parseGlobal(src, name) {
  // [ \t]* rather than \s*: \s* would rescan every following newline (quadratic on blank lines).
  const re = new RegExp(`(?:^|\\n)[ \\t]*${String(name).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}[ \\t]*=`);
  const m = re.exec(String(src));
  return m ? parse(String(src).slice(m.index + m[0].length)) : undefined;
}
module.exports = {
  parseGlobal,
  LuaParseError,
};
