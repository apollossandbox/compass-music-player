// Compass desktop shell. The app itself is app/index.html; this file opens the window
// and keeps the app up to date from GitHub.
const { app, BrowserWindow, shell, session, dialog, net, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Same data folder as before the rename (%APPDATA%\Tamed Player), so updates keep your projects.
app.setName('Compass Music Player');
app.setPath('userData', path.join(app.getPath('appData'), 'Tamed Player'));
app.setAppUserModelId('com.trulytamed.tamedplayer');
if (!app.requestSingleInstanceLock()) app.quit();

// Every new installer pushed to GitHub updates this file; the app compares versions against it.
const FEED = process.env.COMPASS_FEED || 'https://raw.githubusercontent.com/apollossandbox/tamed-player/main/installer/latest.json';

/* ---------- instant updates: most releases only change app/ (the page). Those download in the background,
   are checked file by file against latest.json, and load on Reload. A release that changes the native part
   (different shell fingerprint) still goes through the installer. A newer installer always wins. ---------- */
const SHELL = require('./shell-hash')(__dirname, process.versions.electron);
const sha = b => require('crypto').createHash('sha256').update(b).digest('hex');
const liveRoot = () => path.join(app.getPath('userData'), 'live');
function liveCurrent() {
  return null; // instant updates are off: always run the installed version (installers only)
  try { const c = JSON.parse(fs.readFileSync(path.join(liveRoot(), 'current.json'), 'utf8'));
    if (c && c.shell === SHELL && /^v[\d.]+$/.test(c.dir) && newer(c.version, app.getVersion()) && fs.existsSync(path.join(liveRoot(), c.dir, 'index.html'))) return c; } catch (e) {}
  return null;
}
const appVersion = () => (liveCurrent() || {}).version || app.getVersion();
const indexPath = () => { const c = liveCurrent(); return c ? path.join(liveRoot(), c.dir, 'index.html') : path.join(__dirname, 'app', 'index.html'); };
function liveCleanup() { if (!liveCurrent()) { try { fs.rmSync(liveRoot(), { recursive: true, force: true }); } catch (e) {} } } // stale after an installer update
async function liveUpdate(info) {
  const L = info.live, dirName = 'v' + info.version, root = liveRoot(), tmp = path.join(root, dirName + '.part'), dest = path.join(root, dirName), base = new URL('app/', FEED).toString();
  if (!/^[\d.]+$/.test(info.version) || !Array.isArray(L.files) || !L.files.some(f => f.p === 'index.html')) throw new Error('The update file is incomplete.');
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
  const cur = liveCurrent(), have = [path.join(__dirname, 'app'), ...(cur ? [path.join(root, cur.dir)] : [])], total = L.files.reduce((n, f) => n + (f.size || 0), 0); let got = 0;
  try {
    for (const f of L.files) {
      if (typeof f.p !== 'string' || !/^[\w .()\-]+(\/[\w .()\-]+)*$/.test(f.p) || f.p.split('/').includes('..') || !/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error('The update file lists a bad path.');
      let buf = null; for (const d of have) { try { const b = fs.readFileSync(path.join(d, f.p)); if (sha(b) === f.sha256) { buf = b; break; } } catch (e) {} } // unchanged files are copied, not downloaded
      if (!buf) { const r = await net.fetch(base + f.p.split('/').map(encodeURIComponent).join('/') + '?v=' + info.version, { cache: 'no-store' }); if (!r.ok) throw new Error('Download failed for ' + f.p + ' (' + r.status + ').');
        buf = Buffer.from(await r.arrayBuffer()); if (sha(buf) !== f.sha256) throw new Error('A downloaded file did not match (' + f.p + '). Try again in a few minutes.'); }
      const out = path.join(tmp, ...f.p.split('/')); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, buf);
      got += f.size || 0; if (win && total) win.setProgressBar(got / total);
    }
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; } finally { if (win) win.setProgressBar(-1); }
  fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(tmp, dest);
  fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify({ version: info.version, shell: SHELL, dir: dirName }));
  for (const n of fs.readdirSync(root)) if (n !== dirName && n !== 'current.json') fs.rmSync(path.join(root, n), { recursive: true, force: true });
  if (win) win.webContents.send('tp-live-ready', info.version); // the page reloads itself once nothing is playing
}

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 660,
    title: 'Compass Music Player', backgroundColor: '#0b0b0c', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, 'app', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
      preload: path.join(__dirname, 'preload.js') }
  });
  liveCleanup(); win.loadFile(indexPath());
  win.webContents.on('did-fail-load', (e, code, desc, url, main) => { if (main && liveCurrent() && /[\\/]live[\\/]/.test(decodeURIComponent(url))) { try { fs.rmSync(path.join(liveRoot(), 'current.json'), { force: true }); } catch (x) {} win.loadFile(path.join(__dirname, 'app', 'index.html')); } });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
}

const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
let checking = false;
async function checkForUpdates(manual) {
  if (checking) return; checking = true;
  try {
    // GitHub's API answers without the raw-file cache, so a new version shows up right away; the raw address is the fallback
    let r = await net.fetch('https://api.github.com/repos/apollossandbox/tamed-player/contents/installer/latest.json?ref=main', { cache: 'no-store', headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'Compass' } }).catch(() => null);
    if (process.env.COMPASS_FEED || !r || !r.ok) r = await net.fetch(FEED + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? 'Update file not found. The tamed-player repository on GitHub must be public.' : 'GitHub returned error ' + r.status + '.');
    const info = await r.json();
    const showLog = () => { if (win) win.webContents.send('tp-changelog', { changelog: Array.isArray(info.changelog) ? info.changelog : [], since: app.getVersion() }); };
    if (!info.version || !newer(info.version, appVersion())) {
      if (manual) { const { response } = await dialog.showMessageBox(win, { type: 'info', buttons: ['OK', "What's new"], defaultId: 0, cancelId: 0, message: 'Compass is up to date', detail: 'You have version ' + appVersion() + '.' }); if (response === 1) showLog(); }
      return;
    }
    const { response } = await dialog.showMessageBox(win, {
      type: 'info', buttons: ['Download and install', "What's new", 'Later'], defaultId: 0, cancelId: 2,
      message: `Compass ${info.version} is available`,
      detail: `You have ${appVersion()}.${info.notes ? '\n\n' + info.notes : ''}\n\nYour projects are kept.`
    });
    if (response === 1) { showLog(); return; }
    if (response !== 0) return;
    const url = new URL(info.file || 'Compass-Setup.exe', FEED).toString();
    const dest = path.join(app.getPath('temp'), `Compass-Setup-${info.version}.exe`);
    const res = await net.fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('Download failed (' + res.status + ').');
    const total = +res.headers.get('content-length') || 0, reader = res.body.getReader(), chunks = []; let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); got += value.length; if (total && win) win.setProgressBar(got / total); }
    if (win) win.setProgressBar(-1);
    fs.writeFileSync(dest, Buffer.concat(chunks));
    spawn(dest, [], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 800);
  } catch (e) {
    if (win) win.setProgressBar(-1);
    if (manual) dialog.showMessageBox(win, { type: 'warning', message: "Couldn't check for updates", detail: (e && e.message) || String(e) });
  } finally { checking = false; }
}

/* ---------- FL Studio link ---------- */
// The FL Studio script lives in FL's user data folder: Documents\Image-Line\FL Studio\Settings\Hardware\Compass.
// WAVs sent to FL are kept in Documents\Compass\Sent to FL Studio, because FL projects point at the file on disk.
const flUserDir = () => path.join(app.getPath('documents'), 'Image-Line', 'FL Studio');
const sentDir = () => path.join(app.getPath('documents'), 'Compass', 'Sent to FL Studio');
const cleanName = n => String(n || 'track.wav').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150) || 'track.wav';
async function installFlScript() {
  let base = flUserDir();
  if (!fs.existsSync(base)) {
    const r = await dialog.showOpenDialog(win, { title: 'Select your FL Studio user data folder', message: 'Usually Documents\\Image-Line\\FL Studio. Check Options > File settings in FL Studio.', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    base = r.filePaths[0]; if (path.basename(base).toLowerCase() === 'image-line') base = path.join(base, 'FL Studio');
  }
  const dir = path.join(base, 'Settings', 'Hardware', 'Compass');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fl', 'device_Compass.py'), path.join(dir, 'device_Compass.py'));
  return { ok: true, dir };
}
const dragIcon = () => { const i = nativeImage.createFromPath(path.join(__dirname, 'app', 'icon.png')); return i.isEmpty() ? i : i.resize({ width: 48, height: 48 }); };

/* ---------- Launcher: find DAWs in their usual install folders ---------- */
function dawScan() {
  const env = process.env, PF = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const ls = dir => { try { return fs.readdirSync(dir); } catch (e) { return []; } }, ex = f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } };
  // each rule: base folder under a Program Files root, a folder-name pattern, and exe names to look for (newest folder wins)
  const rules = {
    fl: [['Image-Line', /^FL Studio/i, ['FL64.exe', 'FL.exe']]],
    ableton: [['Ableton', /^Live/i, null]],
    studioone: [['PreSonus', /^Studio One/i, ['Studio One.exe']]],
    reaper: [['', /^REAPER/i, ['reaper.exe']]],
    cubase: [['Steinberg', /^Cubase/i, null]],
    bitwig: [['', /^Bitwig Studio/i, ['Bitwig Studio.exe']]],
    protools: [['Avid', /^Pro Tools/i, ['ProTools.exe']]],
    reason: [['Propellerhead', /^Reason/i, null], ['Reason Studios', /^Reason/i, null]]
  };
  const out = {}, versions = {}, addVer = (id, label, p) => { const v = versions[id] = versions[id] || []; if (!v.some(x => x.path.toLowerCase() === p.toLowerCase())) v.push({ label, path: p }); };
  if (process.platform === 'darwin') {
    const apps = ls('/Applications'), MAC = { fl: /^FL Studio/i, ableton: /^Ableton Live/i, logic: /^Logic Pro/i, studioone: /^Studio One/i, reaper: /^REAPER/i, cubase: /^Cubase/i, bitwig: /^Bitwig/i, protools: /^Pro Tools/i, reason: /^Reason/i, garageband: /^GarageBand/i };
    for (const [id, re] of Object.entries(MAC)) apps.filter(n => re.test(n)).sort().reverse().forEach(a => addVer(id, a.replace(/\.app$/i, ''), path.join('/Applications', a)));
    const pick = re => { const a = apps.filter(n => re.test(n)).sort().pop(); return a ? path.join('/Applications', a) : null; };
    Object.assign(out, { fl: pick(/^FL Studio/i), ableton: pick(/^Ableton Live/i), logic: pick(/^Logic Pro/i), studioone: pick(/^Studio One/i), reaper: pick(/^REAPER/i), cubase: pick(/^Cubase/i), bitwig: pick(/^Bitwig/i), protools: pick(/^Pro Tools/i), reason: pick(/^Reason/i), garageband: pick(/^GarageBand/i) });
  } else {
    for (const [id, rs] of Object.entries(rules)) {
      for (const root of PF) for (const [base, re, exes] of rs) {
        const b = path.join(root, base);
        for (const dir of ls(b).filter(n => re.test(n)).sort((x, y) => y.localeCompare(x, undefined, { numeric: true }))) {
          const full = path.join(b, dir), cands = exes ? exes.map(e => path.join(full, e)) : [...ls(full), ...ls(path.join(full, 'Program')).map(n => path.join('Program', n))].filter(n => /\.exe$/i.test(n) && !/unins|crash|helper|setup/i.test(n)).map(n => path.join(full, n));
          const hit = cands.find(ex); if (hit) { if (!out[id]) out[id] = hit; addVer(id, dir + (/\(x86\)/i.test(root) ? ' (32-bit)' : ''), hit); }
        }
      }
    }
  }
  Object.keys(out).forEach(k => { if (!out[k]) delete out[k]; });
  out.versions = versions; // every install found, newest first, for the Launcher's right-click menu
  return out;
}

/* ---------- FL Studio projects for the Launcher ----------
   Recent = .flp files Windows lists under Recent Items (what you opened lately), plus the newest .flp files in
   FL's Projects folder and any folders you added. FL's own autosave "Backup" folder is skipped. */
function flpWalk(dir, depth, out, re = /\.flp$/i) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const d of ents) { const f = path.join(dir, d.name);
    if (d.isDirectory()) { if (depth > 0 && !/^(backup|autosave)s?$/i.test(d.name) && !d.name.startsWith('.')) flpWalk(f, depth - 1, out, re); }
    else if (re.test(d.name)) { try { out.push({ path: f, time: fs.statSync(f).mtimeMs, how: 'saved' }); } catch (e) {} } }
}
/* A zipped loop package (FL Studio: File > Export > Project data files) is a .zip with an .flp inside.
   Only the zip's file list (its central directory, at the end of the file) is read, so this stays fast. */
function zipHasFlp(file) {
  let fd; try { fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size; if (size < 22) return false;
    const tail = Math.min(size, 65557), buf = Buffer.alloc(tail); fs.readSync(fd, buf, 0, tail, size - tail);
    let e = -1; for (let i = tail - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; } if (e < 0) return false;
    const cdSize = buf.readUInt32LE(e + 12), cdOff = buf.readUInt32LE(e + 16); if (!cdSize || cdSize > 16 * 1048576 || cdOff + cdSize > size) return false;
    const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) { const n = cd.readUInt16LE(p + 28), x = cd.readUInt16LE(p + 30), c = cd.readUInt16LE(p + 32);
      if (/\.flp$/i.test(cd.toString('utf8', p + 46, p + 46 + n))) return true; p += 46 + n + x + c; }
    return false;
  } catch (err) { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {} }
}
function flAll(extraDirs, kind, backupDir) {
  if (kind === 'backup') return flBackups(backupDir);
  const zip = kind === 'zip', extra = Array.isArray(extraDirs) ? extraDirs.filter(d => typeof d === 'string') : [];
  // loop packages from other people usually land in Downloads, so zipped ones are looked for there too
  const roots = [path.join(flUserDir(), 'Projects'), ...extra, ...(zip ? [app.getPath('downloads')] : [])], seen = new Set(), out = [];
  for (const root of roots) { const found = []; flpWalk(root, zip && root === app.getPath('downloads') ? 1 : 5, found, zip ? /\.zip$/i : /\.flp$/i);
    for (const x of found) { const k = x.path.toLowerCase(); if (seen.has(k) || out.length >= 5000) continue; seen.add(k); if (zip && !zipHasFlp(x.path)) continue;
      let size = 0; try { size = fs.statSync(x.path).size; } catch (e) {}
      const rel = path.relative(root, path.dirname(x.path)); out.push(withVer({ path: x.path, name: path.basename(x.path, path.extname(x.path)), folder: [path.basename(root), ...(rel ? rel.split(/[\\/]+/) : [])].join(' › '), time: x.time, size })); } }
  return out;
}
/* The FL Studio version an .flp was saved with: event 199 (FLP_Version) in its FLdt chunk, e.g. "21.2.3.4004".
   Events: id < 64 one byte, < 128 two, < 192 four, otherwise a varint length and that many bytes. */
function flpVersion(file) {
  try { const fd = fs.openSync(file, 'r'), b = Buffer.alloc(4096), n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
    if (n < 22 || b.toString('latin1', 0, 4) !== 'FLhd') return '';
    let i = 8 + b.readUInt32LE(4); if (b.toString('latin1', i, i + 4) !== 'FLdt') return ''; i += 8;
    while (i < n) { const id = b[i++]; if (id < 64) i += 1; else if (id < 128) i += 2; else if (id < 192) i += 4;
      else { let len = 0, sh = 0, c; do { c = b[i++]; len |= (c & 127) << sh; sh += 7; } while (c & 128 && i < n && sh < 28);
        if (id === 199) { const v = b.toString('latin1', i, Math.min(n, i + len)).replace(/\0[\s\S]*$/, ''); return /^\d+(\.\d+)*$/.test(v) ? v : ''; } i += len; } }
  } catch (e) {} return '';
}
const flMajor = v => { const m = /^(\d+)\./.exec(v || ''); return m ? +m[1] : 0; };
// "FL Studio 20" → 20, "FL Studio 21" → 21, "FL Studio 2024" → 24 (2024 is version 24)
const installMajor = label => { const m = /(\d{2,4})/.exec(label || ''); if (!m) return 0; const n = +m[1]; return n >= 2000 ? n - 2000 : n; };
function flExeFor(file, fallback) {
  const want = flMajor(flpVersion(file)); if (!want) return fallback;
  const hit = ((dawScan().versions || {}).fl || []).find(x => installMajor(x.label) === want); return hit ? hit.path : fallback;
}
const withVer = x => ({ ...x, ver: /\.flp$/i.test(x.path) ? flMajor(flpVersion(x.path)) || 0 : 0 });
/* FL Studio's own autosaves live in Projects\\Backup; a different backup folder can be chosen in Compass */
function flBackups(dir) {
  const root = typeof dir === 'string' && dir && fs.existsSync(dir) ? dir : path.join(flUserDir(), 'Projects', 'Backup'), found = [];
  flpWalk(root, 2, found);
  return found.slice(0, 5000).map(x => { let size = 0; try { size = fs.statSync(x.path).size; } catch (e) {} const rel = path.relative(root, path.dirname(x.path));
    return withVer({ path: x.path, name: path.basename(x.path, path.extname(x.path)), folder: [path.basename(root), ...(rel ? rel.split(/[\\/]+/) : [])].join(' › '), time: x.time, size }); });
}
function flRecent(extraDirs, opened, n) {
  const seen = new Map(), add = x => { const k = x.path.toLowerCase(); const o = seen.get(k); if (!o || x.time > o.time) seen.set(k, o && o.how === 'opened' && x.how !== 'opened' ? { ...x, how: 'opened', time: Math.max(x.time, o.time) } : x); };
  if (process.platform === 'win32') { const rec = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Recent');
    try { for (const f of fs.readdirSync(rec)) { if (!/\.flp\.lnk$/i.test(f)) continue; try { const lnk = path.join(rec, f), t = shell.readShortcutLink(lnk).target; if (t && /\.flp$/i.test(t) && fs.existsSync(t)) add({ path: t, time: fs.statSync(lnk).mtimeMs, how: 'opened' }); } catch (e) {} } } catch (e) {} }
  for (const o of (Array.isArray(opened) ? opened : [])) if (o && typeof o.path === 'string' && /\.flp$/i.test(o.path) && fs.existsSync(o.path)) add({ path: o.path, time: +o.time || 0, how: 'opened' });
  const found = []; for (const d of [path.join(flUserDir(), 'Projects'), ...(Array.isArray(extraDirs) ? extraDirs : [])]) if (typeof d === 'string') flpWalk(d, 3, found);
  found.forEach(add);
  return [...seen.values()].sort((a, b) => b.time - a.time).slice(0, n || 6).map(x => withVer({ ...x, name: path.basename(x.path, path.extname(x.path)), dir: path.basename(path.dirname(x.path)) }));
}

/* ---------- mods: Documents\Compass\Mods\<mod>\ with mod.json, and optional style.css and main.js ---------- */
const modsDir = () => path.join(app.getPath('documents'), 'Compass', 'Mods');
const EXAMPLE_MOD = {
  'mod.json': JSON.stringify({ name: 'Example: now playing toast', version: '1.0', author: 'Compass', description: 'Shows a small message when a new song starts, and adds "Copy title" to the song menu. Read main.js to see how mods work.' }, null, 2) + '\n',
  'main.js': `// Mods run in a sandbox. They can't touch the page directly; they use the "compass" object:
//   compass.on('track', t => ...)        a new song started: { id, title, artist, project }
//   compass.on('play' | 'pause' | 'view', fn)
//   compass.toast('text')                small message at the top
//   compass.addMenuItem('song' | 'project', 'Label', info => ...)
//   compass.player.play() / pause() / next() / prev()
//   compass.library().then(projects => ...)   read-only list of projects and songs
// The Music Store and Marketplace are not reachable from mods.
compass.on('track', t => compass.toast('Now playing: ' + t.title));
compass.addMenuItem('song', 'Copy title (example mod)', s => { navigator.clipboard && navigator.clipboard.writeText(s.title); compass.toast('Copied ' + s.title); });
`,
  'style.css': `/* Mod styles apply everywhere except the Music Store and Marketplace. Example: */
/* .row b { letter-spacing: .01em; } */
`
};
const THEMES_MOD = {
  'mod.json': JSON.stringify({ name: 'Themes', version: '1.0', author: 'Compass', description: 'Extra color themes. Pick one in Settings › Appearance. Add your own in mod.json.',
    themes: [
      { name: 'Midnight', base: 'dark', colors: { bg: '#090e1a', panel: '#0f1628', panel2: '#162036', panel3: '#202c48', line: 'rgba(150,180,255,.12)', ink: '#eef2ff', ink2: 'rgba(238,242,255,.8)', ink3: 'rgba(238,242,255,.6)', onink: '#090e1a' } },
      { name: 'Forest', base: 'dark', colors: { bg: '#0a110d', panel: '#0f1913', panel2: '#15231b', panel3: '#1e3226', line: 'rgba(160,255,200,.1)', ink: '#eefaf2', ink2: 'rgba(238,250,242,.8)', ink3: 'rgba(238,250,242,.6)', onink: '#0a110d' } },
      { name: 'Rose', base: 'dark', colors: { bg: '#130a0e', panel: '#1b0f15', panel2: '#25151d', panel3: '#321d28', line: 'rgba(255,170,200,.11)', ink: '#fff0f5', ink2: 'rgba(255,240,245,.8)', ink3: 'rgba(255,240,245,.6)', onink: '#130a0e' } },
      { name: 'OLED Black', base: 'dark', colors: { bg: '#000000', panel: '#060606', panel2: '#0e0e0f', panel3: '#18181a', line: 'rgba(255,255,255,.07)', ink: '#ffffff', ink2: 'rgba(255,255,255,.78)', ink3: 'rgba(255,255,255,.58)', onink: '#000000' } },
      { name: 'Sand', base: 'light', colors: { bg: '#eee8dd', panel: '#faf6ee', panel2: '#f1eadd', panel3: '#e4d9c8', line: 'rgba(60,40,10,.12)', ink: '#1f1a13', ink2: 'rgba(31,26,19,.78)', ink3: 'rgba(31,26,19,.62)', onink: '#faf6ee' } },
      { name: 'Ice', base: 'light', colors: { bg: '#e9eff7', panel: '#f8fbff', panel2: '#edf2f9', panel3: '#dce5f1', line: 'rgba(20,40,80,.11)', ink: '#0f1726', ink2: 'rgba(15,23,38,.78)', ink3: 'rgba(15,23,38,.62)', onink: '#f8fbff' } }
    ] }, null, 2) + '\n',
  'README.txt': 'Compass Themes\r\n\r\nEach theme in mod.json has a name, a base (light or dark) and colors.\r\nTo make your own: copy a theme, rename it, change the colors (hex like #1a2b3c or rgba(...)), save,\r\nthen in Compass open Settings and press Reload next to Mods.\r\n\r\nColors: bg (window), panel, panel2, panel3 (cards and fields), line (borders), ink, ink2, ink3 (text), onink (text on solid buttons).\r\n'
};
const BUILTIN_MODS = { themes: ['compass-themes', THEMES_MOD] };
const THEME_KEYS = ['bg', 'panel', 'panel2', 'panel3', 'line', 'ink', 'ink2', 'ink3', 'onink', 'field', 'hover', 'sel', 'shadow'];
const okColor = v => typeof v === 'string' && /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/i.test(v.trim());
const cleanThemes = t => (Array.isArray(t) ? t : []).slice(0, 40).filter(x => x && typeof x.name === 'string' && x.colors && typeof x.colors === 'object')
  .map(x => ({ name: x.name.slice(0, 40), base: x.base === 'light' ? 'light' : 'dark', colors: Object.fromEntries(THEME_KEYS.filter(k => okColor(x.colors[k])).map(k => [k, x.colors[k].trim()])) }));
function modsList() {
  const dir = modsDir(), out = []; let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  const read = f => { try { const st = fs.statSync(f); return st.isFile() && st.size < 1048576 ? fs.readFileSync(f, 'utf8') : ''; } catch (e) { return ''; } };
  for (const d of ents) { if (!d.isDirectory() || d.name.startsWith('.')) continue; const base = path.join(dir, d.name); let meta = {};
    try { meta = JSON.parse(read(path.join(base, 'mod.json')) || '{}'); } catch (e) { meta = { error: 'mod.json is not valid JSON' }; }
    out.push({ id: d.name, themes: cleanThemes(meta.themes), name: String(meta.name || d.name).slice(0, 80), version: String(meta.version || '').slice(0, 20), author: String(meta.author || '').slice(0, 60), description: String(meta.description || '').slice(0, 240), error: meta.error || '', css: read(path.join(base, 'style.css')), js: read(path.join(base, 'main.js')) }); }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------- converter: links (YouTube and other video sites) through yt-dlp, fetched on first use ---------- */
const ytBin = () => process.env.COMPASS_YTDLP || path.join(app.getPath('userData'), 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
async function ensureYt() {
  const f = ytBin(); if (fs.existsSync(f) && (process.env.COMPASS_YTDLP || Date.now() - fs.statSync(f).mtimeMs < 7 * 864e5)) return f;
  if (fs.existsSync(f)) { try { return await fetchYt(f); } catch (e) { return f; } }
  return fetchYt(f);
}
async function fetchYt(f) {
  const name = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp';
  const r = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + name); if (!r.ok) throw new Error('Could not download the link tool (yt-dlp): HTTP ' + r.status);
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.part', Buffer.from(await r.arrayBuffer())); fs.renameSync(f + '.part', f); try { fs.chmodSync(f, 0o755); } catch (e) {}
  return f;
}
function ytGet(url) {
  return new Promise(async (resolve, reject) => {
    let bin; try { bin = await ensureYt(); } catch (e) { return reject(e); }
    const tmp = fs.mkdtempSync(path.join(app.getPath('temp'), 'compass-'));
    const p = spawn(bin, ['--no-playlist', '--no-progress', '--js-runtimes', 'node:' + process.execPath, '-f', 'bestaudio/best', '-o', path.join(tmp, '%(title).120B.%(ext)s'), '--print', 'after_move:filepath', url], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { p.kill(); reject(new Error('The download took too long')); }, 15 * 60 * 1000);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer);
      const file = out.trim().split(/\r?\n/).filter(Boolean).pop();
      if (code !== 0 || !file || !fs.existsSync(file)) { const L = err.trim().split(/\r?\n/).filter(Boolean), msg = L.filter(l => /^ERROR:/.test(l)).pop() || L.filter(l => !/^WARNING:/.test(l)).pop() || 'The link could not be downloaded';
        return reject(new Error(msg.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, ''))); }
      try { const data = fs.readFileSync(file); resolve({ name: path.basename(file), data }); } catch (e) { reject(e); } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} } });
  });
}

app.whenReady().then(() => {
  ipcMain.handle('tp-conv-link', async (e, url) => { try { if (typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url.trim())) throw new Error('Paste a full link starting with http'); const r = await ytGet(url.trim()); return { ok: true, name: r.name, data: r.data }; } catch (err) { return { ok: false, error: String(err && err.message || err) }; } });
  ipcMain.handle('tp-conv-save', async (e, name, data, dir, pick) => {
    if (pick || !dir || !fs.existsSync(dir)) { const r = await dialog.showOpenDialog(win, { title: 'Save converted files in…', properties: ['openDirectory', 'createDirectory'] }); if (r.canceled) return null; dir = r.filePaths[0]; }
    let f = path.join(dir, cleanName(name)); const ext = path.extname(f), base = f.slice(0, -ext.length); for (let i = 2; fs.existsSync(f); i++) f = `${base} (${i})${ext}`;
    fs.writeFileSync(f, Buffer.from(data)); return { dir, file: f };
  });
  ipcMain.handle('tp-conv-reveal', (e, f) => { if (typeof f === 'string' && fs.existsSync(f)) shell.showItemInFolder(f); });
  ipcMain.handle('tp-recover', () => { try { return require('./recover').findLibraries(app.getPath('userData'), 'glassroom.v2').slice(0, 8).map(x => ({ tracks: x.tracks, cols: x.cols, json: x.json })); } catch (e) { return []; } });
  require('./online').register(ipcMain); // Google sign-in + online profile (hidden until online.json exists)
  ipcMain.handle('tp-mods-list', () => modsList());
  ipcMain.handle('tp-mods-get', (e, key) => { const b = BUILTIN_MODS[key]; if (!b) return { ok: false }; const dir = path.join(modsDir(), b[0]);
    try { fs.mkdirSync(dir, { recursive: true }); for (const [f, c] of Object.entries(b[1])) { const fp = path.join(dir, f); if (!fs.existsSync(fp)) fs.writeFileSync(fp, c); } return { ok: true, id: b[0] }; } catch (err) { return { ok: false, error: err.message }; } });
  ipcMain.handle('tp-mods-folder', async () => { const dir = modsDir(); fs.mkdirSync(dir, { recursive: true });
    if (!fs.readdirSync(dir).length) { const ex = path.join(dir, 'example-now-playing'); fs.mkdirSync(ex, { recursive: true }); for (const [f, c] of Object.entries(EXAMPLE_MOD)) fs.writeFileSync(path.join(ex, f), c); }
    await shell.openPath(dir); return dir; });
  ipcMain.handle('tp-daw-scan', () => dawScan());
  ipcMain.handle('tp-fl-recent', (e, dirs, opened, n) => flRecent(dirs, opened, n));
  ipcMain.handle('tp-fl-all', (e, dirs, kind, bdir) => flAll(dirs, kind, bdir));
  ipcMain.handle('tp-fl-reveal', (e, file) => { if (typeof file === 'string' && /\.(flp|zip)$/i.test(file) && fs.existsSync(file)) { shell.showItemInFolder(file); return true; } return false; });
  // open a project in FL Studio: with the FL program Compass found when there is one, otherwise whatever opens .flp files
  ipcMain.handle('tp-fl-open', async (e, file, exe) => {
    if (typeof file !== 'string' || !/\.(flp|zip)$/i.test(file) || !fs.existsSync(file)) return { ok: false, error: 'That project file is gone' };
    const zipped = /\.zip$/i.test(file); if (zipped && !zipHasFlp(file)) return { ok: false, error: 'That zip has no FL Studio project in it' };
    if (!zipped) exe = flExeFor(file, exe);
    if (typeof exe === 'string' && /\.(exe|app)$/i.test(exe) && fs.existsSync(exe)) { try { require('child_process').spawn(exe, [file], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) }).unref(); return { ok: true }; } catch (err) {} }
    if (zipped) return { ok: false, error: "Compass can't find FL Studio. Use Add DAW in the Launcher, then try again." }; // Windows would open the zip in Explorer instead
    const err = await shell.openPath(file); return err ? { ok: false, error: err } : { ok: true };
  });
  ipcMain.handle('tp-fl-pick', async (e, what) => {
    const dir = path.join(flUserDir(), 'Projects'), folder = what === 'folder';
    const r = await dialog.showOpenDialog(win, { title: folder ? 'Add a folder with FL Studio projects' : 'Open an FL Studio project', defaultPath: fs.existsSync(dir) ? dir : app.getPath('documents'), properties: folder ? ['openDirectory'] : ['openFile'], filters: folder ? [] : [{ name: 'FL Studio projects and zipped loop packages', extensions: ['flp', 'zip'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  // the program's own icon, as Windows or macOS shows it
  ipcMain.handle('tp-daw-icon', async (e, file) => { try { if (typeof file !== 'string' || !fs.existsSync(file)) return null; const im = await app.getFileIcon(file, { size: 'large' }); return im.isEmpty() ? null : im.toDataURL(); } catch (err) { return null; } });
  // videos go straight to the Downloads folder, no dialog
  ipcMain.handle('tp-save-downloads', (e, name, data) => { try { const dir = app.getPath('downloads'); let f = path.join(dir, cleanName(name)); const ext = path.extname(f), base = f.slice(0, -ext.length); for (let i = 2; fs.existsSync(f); i++) f = `${base} (${i})${ext}`; fs.writeFileSync(f, Buffer.from(data)); shell.showItemInFolder(f); return f; } catch (err) { return null; } });
  ipcMain.handle('tp-daw-open', async (e, file) => { if (typeof file !== 'string' || !fs.existsSync(file) || !/\.(exe|app|lnk)$/i.test(file)) return { ok: false, error: 'That program was not found' }; const err = await shell.openPath(file); return err ? { ok: false, error: err } : { ok: true }; });
  ipcMain.handle('tp-daw-locate', async (e, name) => { const r = await dialog.showOpenDialog(win, { title: 'Find ' + (name || 'your DAW'), properties: process.platform === 'darwin' ? ['openFile', 'treatPackageAsDirectory'] : ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe', 'lnk'] }] : [] }); return r.canceled ? null : r.filePaths[0]; });
  // Web MIDI (with SysEx) is how the app talks to the FL Studio script
  // camera yes (QR scanner), microphone no
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(perm === 'media' ? !(details && details.mediaTypes || []).includes('audio') : ['midi', 'midiSysex', 'clipboard-sanitized-write', 'local-fonts'].includes(perm)));
  ipcMain.handle('tp-camera-settings', () => process.platform === 'win32' ? shell.openExternal('ms-settings:privacy-webcam') : false);
  session.defaultSession.setPermissionCheckHandler((wc, perm) => ['midi', 'midiSysex', 'clipboard-sanitized-write', 'local-fonts', 'media'].includes(perm));
  ipcMain.handle('tp-fl-install', () => installFlScript().catch(e => ({ ok: false, error: e.message })));
  ipcMain.handle('tp-fl-status', () => { const f = path.join(flUserDir(), 'Settings', 'Hardware', 'Compass', 'device_Compass.py'); return { flFound: fs.existsSync(flUserDir()), installed: fs.existsSync(f) }; });
  ipcMain.handle('tp-fl-save', (e, name, data) => {
    const dir = sentDir(); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, cleanName(name)); fs.writeFileSync(file, Buffer.from(data)); return file;
  });
  ipcMain.on('tp-drag', (e, file) => { if (typeof file === 'string' && file.startsWith(sentDir()) && fs.existsSync(file)) e.sender.startDrag({ file, icon: dragIcon() }); });
  ipcMain.handle('tp-reveal', (e, file) => { if (typeof file === 'string' && file.startsWith(sentDir()) && fs.existsSync(file)) shell.showItemInFolder(file); else shell.openPath(sentDir()); });
  session.defaultSession.on('will-download', (e, item) => {
    item.setSaveDialogOptions({ title: 'Save from Compass Music Player', defaultPath: path.join(app.getPath('documents'), item.getFilename()) });
  });
  ipcMain.handle('tp-check-updates', () => checkForUpdates(true));
  ipcMain.on('tp-version', e => { e.returnValue = appVersion(); });
  ipcMain.handle('tp-live-reload', () => { if (win && liveCurrent()) win.loadFile(indexPath()); });
  createWindow();
  setTimeout(() => checkForUpdates(false), 6000);
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
