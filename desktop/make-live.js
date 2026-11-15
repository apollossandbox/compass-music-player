/* Publishes app/ for instant updates: mirrors it to ../installer/app and returns the file list with checksums,
   which build-win.sh puts in latest.json. Usage: require('./make-live')() → { shell, files: [{ p, sha256, size }] } */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
module.exports = () => {
  const src = path.join(__dirname, 'app'), out = path.join(__dirname, '..', 'installer', 'app'), files = [];
  fs.rmSync(out, { recursive: true, force: true });
  const walk = rel => { for (const d of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) { const r = rel ? rel + '/' + d.name : d.name;
    if (d.name.startsWith('.')) continue; if (d.isDirectory()) { walk(r); continue; }
    const b = fs.readFileSync(path.join(src, r)); fs.mkdirSync(path.dirname(path.join(out, r)), { recursive: true }); fs.writeFileSync(path.join(out, r), b);
    files.push({ p: r, sha256: crypto.createHash('sha256').update(b).digest('hex'), size: b.length }); } };
  walk('');
  const electron = require('./package.json').devDependencies.electron.replace(/^[^\d]*/, '');
  return { shell: require('./shell-hash')(__dirname, electron), files };
};
