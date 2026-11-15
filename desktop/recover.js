/* Library recovery: find older copies of the library in Chromium's own localStorage files.
   localStorage lives in a LevelDB folder (userData/Local Storage/leveldb). LevelDB keeps earlier values of a key
   in its .log and .ldb files until it compacts them, so a library that was overwritten can often be read back.
   This only reads those files; it never writes to them. */
const fs = require('fs'), path = require('path');

function varint(b, o) { let r = 0, s = 0, c; do { c = b[o.i++]; r += (c & 127) * 2 ** s; s += 7; } while (c & 128 && o.i < b.length); return r; }

// Snappy (LevelDB block compression): literals and back-references
function snappy(src) {
  const o = { i: 0 }, len = varint(src, o), out = Buffer.alloc(len); let op = 0;
  while (o.i < src.length && op < len) {
    const tag = src[o.i++], t = tag & 3;
    if (t === 0) { let l = tag >> 2; if (l >= 60) { const nb = l - 59; l = 0; for (let k = 0; k < nb; k++) l += src[o.i++] * 2 ** (8 * k); } l += 1; src.copy(out, op, o.i, o.i + l); o.i += l; op += l; }
    else { let l, off; if (t === 1) { l = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[o.i++]; } else if (t === 2) { l = (tag >> 2) + 1; off = src.readUInt16LE(o.i); o.i += 2; } else { l = (tag >> 2) + 1; off = src.readUInt32LE(o.i); o.i += 4; }
      if (!off || off > op) throw new Error('bad snappy offset'); for (let k = 0; k < l; k++, op++) out[op] = out[op - off]; }
  }
  return out;
}
// one SSTable block: prefix-compressed entries, then the restart array
function blockEntries(buf) {
  const n = buf.readUInt32LE(buf.length - 4), end = buf.length - 4 - 4 * n, out = [], o = { i: 0 }; let key = Buffer.alloc(0);
  while (o.i < end) { const sh = varint(buf, o), ns = varint(buf, o), vl = varint(buf, o); key = Buffer.concat([key.subarray(0, sh), buf.subarray(o.i, o.i + ns)]); o.i += ns; out.push([key, buf.subarray(o.i, o.i + vl)]); o.i += vl; }
  return out;
}
const readBlock = (f, off, size) => { const raw = f.subarray(off, off + size); return f[off + size] === 1 ? snappy(raw) : raw; };
function tableEntries(f) { // .ldb: footer → index block → data blocks
  const ft = f.subarray(f.length - 48), o = { i: 0 }; varint(ft, o); varint(ft, o); const io = varint(ft, o), is = varint(ft, o), out = [];
  for (const [, h] of blockEntries(readBlock(f, io, is))) { const p = { i: 0 }, off = varint(h, p), sz = varint(h, p); try { out.push(...blockEntries(readBlock(f, off, sz))); } catch (e) {} }
  return out;
}
function logEntries(f) { // .log: 32 KB blocks of record fragments, each a WriteBatch
  const recs = []; let cur = null;
  for (let b = 0; b < f.length; b += 32768) { let i = b; const end = Math.min(b + 32768, f.length);
    while (i + 7 <= end) { const len = f.readUInt16LE(i + 4), type = f[i + 6]; if (!type && !len) break; const d = f.subarray(i + 7, i + 7 + len); i += 7 + len;
      if (type === 1) recs.push(d); else if (type === 2) cur = [d]; else if (type === 3 && cur) cur.push(d); else if (type === 4 && cur) { cur.push(d); recs.push(Buffer.concat(cur)); cur = null; } } }
  const out = [];
  for (const r of recs) { try { const o = { i: 12 }, count = r.readUInt32LE(8); for (let k = 0; k < count; k++) { const t = r[o.i++], kl = varint(r, o), key = r.subarray(o.i, o.i + kl); o.i += kl; if (t === 1) { const vl = varint(r, o); out.push([key, r.subarray(o.i, o.i + vl)]); o.i += vl; } } } catch (e) {} }
  return out;
}
// Chromium stores a localStorage value as 0x00 + UTF-16LE or 0x01 + Latin-1
const decode = v => v[0] === 0 ? v.subarray(1).toString('utf16le') : v[0] === 1 ? v.subarray(1).toString('latin1') : null;

function findLibraries(userData, keyName) {
  const dir = path.join(userData, 'Local Storage', 'leveldb'), want = Buffer.from(keyName, 'latin1'), seen = new Set(), found = [];
  let files = []; try { files = fs.readdirSync(dir).filter(n => /\.(log|ldb)$/i.test(n)); } catch (e) { return found; }
  for (const n of files) {
    let f; try { f = fs.readFileSync(path.join(dir, n)); } catch (e) { continue; }
    let ents = []; try { ents = /\.log$/i.test(n) ? logEntries(f) : tableEntries(f); } catch (e) { continue; }
    for (const [k, v] of ents) {
      if (!k.includes(want) || v.length < 20) continue; const s = decode(v); if (!s || seen.has(s.length + ':' + s.slice(0, 200) + s.slice(-200))) continue; seen.add(s.length + ':' + s.slice(0, 200) + s.slice(-200));
      try { const j = JSON.parse(s); if (!j || !Array.isArray(j.tracks)) continue; found.push({ tracks: j.tracks.length, cols: (j.cols || []).length, file: n, json: s }); } catch (e) {}
    }
  }
  return found.sort((a, b) => b.tracks - a.tracks || b.cols - a.cols);
}
module.exports = { findLibraries };
