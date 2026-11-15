/* Fingerprint of the native part of Compass (everything outside app/). An instant update only swaps app/,
   so it is offered only to installs whose fingerprint matches the one it was built with. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const SHELL_FILES = ['main.js', 'preload.js', 'online.js', 'online.json', 'recover.js', 'shell-hash.js']; // online.json: sign-in config ships with the installer
module.exports = (dir, electronVersion) => {
  const h = crypto.createHash('sha256');
  for (const f of SHELL_FILES) { let b; try { b = fs.readFileSync(path.join(dir, f)); } catch (e) { b = Buffer.from('missing'); } h.update(f + '\n'); h.update(b); }
  h.update('electron ' + electronVersion); return h.digest('hex').slice(0, 16);
};
