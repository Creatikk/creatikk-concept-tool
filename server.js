// ───────────────────────────────────────────────────────────────────
// Creatikk — Outil interne d'analyse de concepts viraux.
// Écosystème : Sources → (analyse) → Templates (mémoire) →
// (génération par niche) → Concepts → (résultats) → renforce Templates.
// Démarrage : node server.js   (port 8790)
// ───────────────────────────────────────────────────────────────────
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

(function loadEnv() {
  const files = [path.join(__dirname, '.env'), path.join(__dirname, '..', 'creatikk_demo_server', '.env')];
  for (const f of files) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch {}
  }
})();

const { callClaude, buildAnalyze, buildClassify, buildGenerate, buildConceptSheet, buildAdaptations, buildRefineTemplate } = require('./lib/claude');
const tiktok = require('./lib/tiktok');
const { transcribe } = require('./lib/transcribe');
const { extractFrames, countCuts } = require('./lib/frames');
const store = require('./lib/store');

const PORT = process.env.PORT || 8790;
const TMP = path.join(__dirname, 'tmp');
const now = () => new Date().toISOString();

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
// Lit le corps BINAIRE brut (upload vidéo direct, sans base64/JSON) avec garde-fou taille.
function readRaw(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, killed = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes && !killed) { killed = true; reject(new Error('TOO_BIG')); req.destroy(); return; }
      if (!killed) chunks.push(c);
    });
    req.on('end', () => { if (!killed) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!killed) reject(e); });
  });
}
const byForce = (a, b) => (b.force || 0) - (a.force || 0);

// ── Analyse une vidéo → range dans un template → concepts d'amorce ──
async function handleAnalyze(input) {
  const url = (input.url || '').trim();
  if (!url) throw new Error('Donne un lien TikTok.');
  fs.mkdirSync(TMP, { recursive: true });
  const mp4 = path.join(TMP, 'v_' + Date.now() + '.mp4');

  const info = await tiktok.fetchInfo(url);
  let transcript = (input.transcript || '').trim();
  let framesB64 = [];
  try {
    await tiktok.downloadTo(info.videoUrl, mp4);
    if (!transcript) { try { transcript = (await transcribe(mp4)) || ''; } catch (e) { console.error('transcribe →', e.message); } }
    try { framesB64 = extractFrames(mp4, info.meta.duration, 12); } catch (e) { console.error('frames →', e.message); }
    try { info.meta.cuts = countCuts(mp4); } catch {}
  } finally { try { fs.unlinkSync(mp4); } catch {} }

  // Commentaires les plus likés (signal viral) — après le téléchargement, donc
  // espacé de fetchInfo pour ne pas heurter la limite tikwm (1 req/s).
  let comments = [];
  try { comments = await tiktok.fetchComments(url); } catch (e) { console.error('comments →', e.message); }

  const analysis = await callClaude({ ...buildAnalyze({ meta: info.meta, transcript, framesB64, comments }), maxTokens: 4500 });

  const db = store.load();
  // Fusion : ce concept correspond-il à un template connu ?
  const cls = await callClaude(buildClassify({ sujet: analysis.sujet, templateReutilisable: analysis.templateReutilisable, existing: db.templates }));
  let template = cls.match && cls.templateId ? db.templates.find((t) => t.id === cls.templateId) : null;
  // Garde-fou anti-doublon : si le classeur crée un "nouveau" template mais avec
  // un nom quasi identique à un template existant, on fusionne dedans (évite les
  // "3 fois le même concept").
  if (!template && cls.nom) {
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    template = db.templates.find((t) => norm(t.nom) === norm(cls.nom)) || null;
  }
  const merged = !!template;
  if (template) {
    template.force = (template.force || 1) + 1;
    template.niches = Array.from(new Set([...(template.niches || []), ...(cls.niches || [])]));
  } else {
    template = { id: store.genId('t'), nom: cls.nom, formule: cls.formule, ressorts: cls.ressorts, formatType: cls.formatType, niches: cls.niches || [], force: 1, exempleIds: [], conceptIds: [], createdAt: now() };
    db.templates.unshift(template);
  }

  const source = { id: store.genId('s'), url, meta: info.meta, sujet: analysis.sujet, langueSource: analysis.langueSource, viralite: analysis.viralite, templateReutilisable: analysis.templateReutilisable, analysis, templateId: template.id, createdAt: now() };
  db.sources.unshift(source);
  template.exempleIds.unshift(source.id);

  store.save(db);

  // EN TÂCHE DE FOND (n'allonge plus l'analyse, qui s'affiche vite) : les 3
  // scripts d'adaptation prêts à filmer + la fiche. Ils apparaissent dans le
  // concept ~1 min après l'analyse.
  const tid = template.id;
  (async () => {
    try {
      const out = await callClaude(buildAdaptations({ analysis }));
      const d2 = store.load();
      const t2 = d2.templates.find((t) => t.id === tid);
      if (!t2) return;
      for (const a of out.adaptations || []) {
        const c = { id: store.genId('c'), templateId: tid, templateNom: t2.nom, niche: (t2.niches || [])[0] || '', titre: a.titre, hook: a.hook, astuceGratuite: a.astuceGratuite, scriptVerbatim: a.scriptVerbatim, notesTournage: a.notesTournage, format: a.format, statut: 'idee', origine: 'analyse', sourceUrl: url, createdAt: now() };
        d2.concepts.unshift(c);
        t2.conceptIds.unshift(c.id);
      }
      const srcsAll = d2.sources.filter((s) => s.templateId === tid);
      // Le template s'affine dès qu'il a ≥2 vidéos (plus il y en a, plus il est précis).
      if (srcsAll.length >= 2) {
        try {
          const ref = await callClaude(buildRefineTemplate({ template: t2, sources: srcsAll }));
          if (ref.nom) t2.nom = ref.nom;
          if (ref.formule) t2.formule = ref.formule;
          if (ref.ressorts) t2.ressorts = ref.ressorts;
          if (ref.hookPatterns) t2.hookPatterns = ref.hookPatterns;
          if (ref.pourquoiCaMarche) t2.pourquoiCaMarche = ref.pourquoiCaMarche;
          if (ref.niches) t2.niches = Array.from(new Set([...(t2.niches || []), ...ref.niches]));
          t2.fiche = null; // fiche à régénérer sur la formule affinée
        } catch (e) { console.error('refine bg →', e.message); }
      }
      if (!t2.fiche) { try { t2.fiche = await callClaude(buildConceptSheet({ template: t2, sources: srcsAll })); } catch (e) { console.error('fiche bg →', e.message); } }
      store.save(d2);
    } catch (e) { console.error('adaptations bg →', e.message); }
  })();

  return {
    merged,
    diag: { transcript: !!transcript, frames: framesB64.length },
    template: { id: template.id, nom: template.nom, formule: template.formule, force: template.force, niches: template.niches },
    source: { id: source.id, url, meta: info.meta, sujet: source.sujet },
    analysis,
  };
}

// Analyse ASYNCHRONE : une requête HTTP tenue ~2 min est coupée par les
// proxies (Render) / navigateurs. On lance en tâche de fond et l'interface
// interroge /analyze-status jusqu'à la fin.
const jobs = {};
function startAnalyze(input) {
  const id = store.genId('job');
  jobs[id] = { status: 'pending', _t: Date.now() };
  handleAnalyze(input)
    .then((result) => { jobs[id] = { status: 'done', result, _t: Date.now() }; })
    .catch((e) => { console.error('analyze job →', e.message); jobs[id] = { status: 'error', error: e.message, _t: Date.now() }; });
  for (const k of Object.keys(jobs)) if (Date.now() - jobs[k]._t > 6e5) delete jobs[k]; // purge > 10 min
  return { jobId: id };
}

// ── Génère des concepts à partir des templates ─────────────────────
async function handleGenerate(input) {
  const niche = (input.niche || '').trim();
  if (!niche) throw new Error('Indique une niche.');
  const n = Math.min(Math.max(parseInt(input.n, 10) || 5, 1), 10);
  const db = store.load();
  let templates = [...db.templates].sort(byForce);
  if (input.templateId) templates = templates.filter((t) => t.id === input.templateId);
  const out = await callClaude({ ...buildGenerate({ niche, n, templates: templates.slice(0, 20) }), maxTokens: Math.min(2000 + n * 1400, 8000) });

  const saved = (out.concepts || []).map((c) => {
    const tpl = db.templates.find((t) => t.nom === c.templateNom) || (input.templateId ? db.templates.find((t) => t.id === input.templateId) : null);
    const rec = { id: store.genId('c'), templateId: tpl ? tpl.id : null, templateNom: c.templateNom, niche, titre: c.titre, hook: c.hook, astuceGratuite: c.astuceGratuite, scriptVerbatim: c.scriptVerbatim, notesTournage: c.notesTournage, format: c.format, pourquoiCaMarche: c.pourquoiCaMarche, statut: 'idee', origine: 'generation', createdAt: now() };
    db.concepts.unshift(rec);
    if (tpl) tpl.conceptIds.unshift(rec.id);
    return rec;
  });
  store.save(db);
  return { concepts: saved };
}

// ── Fiche concept (mode d'emploi transmissible) ────────────────────
async function handleConceptSheet(input) {
  const db = store.load();
  const t = db.templates.find((x) => x.id === input.id);
  if (!t) throw new Error('Concept introuvable.');
  const sources = db.sources.filter((s) => s.templateId === t.id);
  const fiche = await callClaude(buildConceptSheet({ template: t, sources }));
  t.fiche = fiche;
  store.save(db);
  return { fiche };
}

// ── Bibliothèque d'assets visuels (chargements Creatikk, analytics…) ─
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ASSETS_DIR = path.join(DATA_DIR, 'assets');
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const extFromMime = (m) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }[m] || 'bin');

async function handleAssetUpload(input) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(input.dataUrl || '');
  if (!m) throw new Error('Fichier manquant ou invalide.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 25 * 1024 * 1024) throw new Error('Fichier trop lourd (max 25 Mo).');
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const id = store.genId('a');
  const file = id + '.' + extFromMime(m[1]);
  fs.writeFileSync(path.join(ASSETS_DIR, file), buf);
  const db = store.load();
  const a = { id, nom: input.nom || file, category: input.category || 'Autre', mime: m[1], file, createdAt: now() };
  db.assets.unshift(a);
  store.save(db);
  return { asset: a };
}
async function handleAssetDelete(input) {
  const db = store.load();
  const i = db.assets.findIndex((a) => a.id === input.id);
  if (i < 0) throw new Error('Asset introuvable.');
  try { fs.unlinkSync(path.join(ASSETS_DIR, db.assets[i].file)); } catch {}
  db.assets.splice(i, 1);
  store.save(db);
  return { ok: true };
}

// ── Marketplace : mur de vidéos d'inspiration (liens ajoutés en masse) ─
// On récupère juste vues + vignette (léger, pas d'analyse IA), et on
// TÉLÉCHARGE la vignette (les URLs TikTok expirent en quelques heures).
async function downloadCover(coverUrl, id) {
  if (!coverUrl) return null;
  try {
    const cres = await fetch(coverUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tiktok.com/' } });
    if (!cres.ok) return null;
    const cbuf = Buffer.from(await cres.arrayBuffer());
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    const coverFile = id + '.jpg';
    fs.writeFileSync(path.join(ASSETS_DIR, coverFile), cbuf);
    return coverFile;
  } catch { return null; }
}
// Télécharge la vidéo (mp4 sans watermark) pour la LIRE en ligne dans la carte
// (service /assets déjà en Range/206 → lecture iOS OK). Garde-fou de taille.
async function downloadVideo(videoUrl, id) {
  if (!videoUrl) return null;
  try {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    const videoFile = id + '.mp4';
    const fp = path.join(ASSETS_DIR, videoFile);
    await tiktok.downloadTo(videoUrl, fp);
    const sz = fs.statSync(fp).size;
    if (!sz || sz > 80 * 1024 * 1024) { try { fs.unlinkSync(fp); } catch {} return null; }
    return videoFile;
  } catch { return null; }
}
// Clé unique d'une vidéo = son ID TikTok (robuste aux variantes d'URL) ;
// à défaut, l'URL normalisée (sans query ni slash final). Sert à empêcher
// TOUT doublon dans l'inspiration (même vidéo importée ET ajoutée à la main).
function videoKey(url) {
  if (!url) return '';
  const m = /\/(?:video|photo|v)\/(\d+)/.exec(url);
  if (m) return m[1];
  return url.split('?')[0].replace(/\/+$/, '').toLowerCase();
}
const marketHasVideo = (db, url) => db.market.some((m) => videoKey(m.url) === videoKey(url));

async function handleMarketAdd(input) {
  const raw = Array.isArray(input.urls) ? input.urls : String(input.urls || input.url || '').split(/[\s,]+/);
  const urls = [...new Set(raw.map((u) => (u || '').trim()).filter((u) => /^https?:\/\//.test(u)))];
  if (!urls.length) throw new Error('Aucun lien valide.');
  const templateId = input.templateId || null;
  const category = (input.category || '').trim() || null;
  const db = store.load();
  const added = [], failed = [];
  for (const url of urls) {
    if (marketHasVideo(db, url)) { failed.push({ url, error: 'déjà présent' }); continue; }
    try {
      const info = await tiktok.fetchInfo(url);
      const meta = info.meta;
      const id = store.genId('mk');
      const coverFile = await downloadCover(meta.cover, id);
      const videoFile = await downloadVideo(info.videoUrl, id);
      const item = { id, url, templateId, category, coverFile, videoFile, author: meta.author, views: meta.views, likes: meta.likes, duration: meta.duration, postDate: meta.postDate, addedAt: now() };
      db.market.unshift(item); added.push(item);
      store.save(db); // sauvegarde à chaque vidéo (un crash ne perd pas les précédentes)
    } catch (e) { failed.push({ url, error: e.message }); }
  }
  return { added, failed };
}
// Importe toutes les vidéos DÉJÀ analysées (sources) dans le marketplace,
// en gardant leur template. Re-fetch pour une vignette fraîche (les URLs
// stockées expirent) ; catégorie = 1ʳᵉ niche du template.
async function handleMarketImportSources() {
  const db = store.load();
  let added = 0, skipped = 0;
  for (const s of db.sources) {
    if (!s.url || marketHasVideo(db, s.url)) { skipped++; continue; }
    const id = store.genId('mk');
    const tpl = db.templates.find((t) => t.id === s.templateId);
    const category = tpl && tpl.niches && tpl.niches[0] ? tpl.niches[0] : null;
    let meta = s.meta || {}, coverFile = null, videoFile = null;
    try { const info = await tiktok.fetchInfo(s.url); meta = { ...meta, ...info.meta }; coverFile = await downloadCover(info.meta.cover, id); videoFile = await downloadVideo(info.videoUrl, id); } catch {}
    db.market.unshift({ id, url: s.url, templateId: s.templateId || null, category, coverFile, videoFile, author: meta.author || null, views: meta.views ?? null, likes: meta.likes ?? null, duration: meta.duration ?? null, postDate: meta.postDate || null, addedAt: now(), fromSource: true });
    added++;
    store.save(db); // sauvegarde à chaque vidéo → un crash/redémarrage ne perd rien
  }
  return { added, skipped };
}
async function handleMarketDelete(input) {
  const db = store.load();
  const i = db.market.findIndex((m) => m.id === input.id);
  if (i < 0) throw new Error('Vidéo introuvable.');
  if (db.market[i].coverFile) { try { fs.unlinkSync(path.join(ASSETS_DIR, db.market[i].coverFile)); } catch {} }
  if (db.market[i].videoFile) { try { fs.unlinkSync(path.join(ASSETS_DIR, db.market[i].videoFile)); } catch {} }
  db.market.splice(i, 1);
  store.save(db);
  return { ok: true };
}

// Fusionne un template dans un autre (nettoyage des doublons) : transfère
// vidéos + concepts + entrées inspiration, cumule force/niches, supprime le 1er.
async function handleTemplateMerge(input) {
  const { fromId, intoId } = input || {};
  if (!fromId || !intoId || fromId === intoId) throw new Error('Choisis deux concepts différents.');
  const db = store.load();
  const from = db.templates.find((t) => t.id === fromId);
  const into = db.templates.find((t) => t.id === intoId);
  if (!from || !into) throw new Error('Concept introuvable.');
  for (const s of db.sources) if (s.templateId === fromId) s.templateId = intoId;
  for (const c of db.concepts) if (c.templateId === fromId) c.templateId = intoId;
  for (const m of db.market) if (m.templateId === fromId) m.templateId = intoId;
  into.force = (into.force || 0) + (from.force || 0);
  into.niches = Array.from(new Set([...(into.niches || []), ...(from.niches || [])]));
  into.exempleIds = Array.from(new Set([...(into.exempleIds || []), ...(from.exempleIds || [])]));
  into.conceptIds = Array.from(new Set([...(into.conceptIds || []), ...(from.conceptIds || [])]));
  into.fiche = null; // fiche à régénérer sur l'ensemble
  db.templates = db.templates.filter((t) => t.id !== fromId);
  store.save(db);
  return { ok: true };
}

// ── MOTION SCAN sur la vidéo du créateur ───────────────────────────
// Ressource « clé en main » : le créateur envoie SA vidéo, ffmpeg colle
// l'overlay de scan Creatikk (pré-rendu transparent, en boucle) par-dessus,
// et renvoie un MP4 prêt à poster (lisible partout, iPhone compris).
// L'overlay `assets_fx/scanfx.apng` (PNG animé transparent, boucle 2,4 s) est
// pré-rendu une fois en local (Chrome n'existe pas sur le serveur Render) et
// versionné avec le repo. APNG choisi car son alpha est lu de façon FIABLE par
// ffmpeg (VP9/WebM perdait la transparence → fond noir).
const SCANFX = path.join(__dirname, 'assets_fx', 'scanfx.apng');

// Compositing ffmpeg ASYNCHRONE + LÉGER (le serveur Render = 512 Mo RAM / 0.5 CPU :
// un rendu 1080p bloquant faisait planter le process → 502). Ici : sortie 720×1280,
// preset ultrafast, 1 thread, spawn non-bloquant, timeout, stderr capturé.
function compositeScan(inPath, outPath) {
  return new Promise((resolve) => {
    const args = [
      '-ignore_loop', '0', '-i', SCANFX,
      '-i', inPath,
      '-filter_complex',
        '[1:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1[b];' +
        '[0:v]scale=720:1280[fx];[b][fx]overlay=shortest=1,format=yuv420p[v]',
      '-map', '[v]', '-map', '1:a?',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '1',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest',
      '-y', outPath,
    ];
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 150000);
    p.on('close', (code) => { clearTimeout(to); resolve({ code, stderr: err }); });
    p.on('error', (e) => { clearTimeout(to); resolve({ code: -1, stderr: e.message }); });
  });
}
// Reçoit la vidéo en BINAIRE BRUT (content-type: video/*, corps = octets du
// fichier). Pas de base64/JSON → 33% plus léger + pas de parsing de longue
// chaîne (le base64 dans du JSON échouait sur les .mov iPhone via le proxy Render).
async function handleScanVideo(req) {
  const mime = (req.headers['content-type'] || '').split(';')[0].trim();
  if (!/^video\//.test(mime)) throw new Error('Envoie une vidéo (mp4, mov ou webm).');
  let buf;
  try { buf = await readRaw(req, 150 * 1024 * 1024); }
  catch (e) { throw new Error(e.message === 'TOO_BIG' ? 'Vidéo trop lourde (max 150 Mo).' : 'Upload interrompu.'); }
  if (!buf || !buf.length) throw new Error('Vidéo vide.');
  if (!fs.existsSync(SCANFX)) throw new Error("Overlay de scan absent (assets_fx/scanfx.apng) — relance le pré-rendu.");
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const id = store.genId('scan');
  const ext = extFromMime(mime) === 'bin' ? 'mp4' : extFromMime(mime);
  const inPath = path.join(TMP, id + '_in.' + ext);
  const outFile = id + '.mp4';
  const outPath = path.join(ASSETS_DIR, outFile);
  fs.writeFileSync(inPath, buf);
  const r = await compositeScan(inPath, outPath);
  try { fs.unlinkSync(inPath); } catch {}
  if (r.code !== 0 || !fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    const tail = (r.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(-300);
    throw new Error('Rendu échoué (code ' + r.code + ') ' + tail);
  }
  return { url: '/assets/' + outFile, file: outFile };
}

const server = http.createServer(async (req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (req.method === 'GET' && (u === '/' || u === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && u.startsWith('/assets/')) {
      const fp = path.join(ASSETS_DIR, path.basename(u));
      if (!fs.existsSync(fp)) return json(res, 404, { error: 'asset introuvable' });
      const stat = fs.statSync(fp);
      const type = MIME[fp.split('.').pop().toLowerCase()] || 'application/octet-stream';
      const range = req.headers.range;
      // Support du streaming (Range/206) — requis pour lire les vidéos sur iOS Safari.
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (isNaN(start)) start = 0;
        if (isNaN(end) || end >= stat.size) end = stat.size - 1;
        if (start > end) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end(); }
        res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(fp, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': stat.size });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(fp).pipe(res);
    }
    if (u === '/health') {
      const db = store.load();
      return json(res, 200, { ok: true, anthropic: !!process.env.ANTHROPIC_API_KEY, groq: !!process.env.GROQ_API_KEY, tiktok: process.env.RAPIDAPI_KEY ? 'rapidapi' : 'tikwm (public)', templates: db.templates.length, sources: db.sources.length, concepts: db.concepts.length });
    }
    if (u === '/templates' && req.method === 'GET') return json(res, 200, store.load().templates.sort(byForce));
    if (u === '/sources' && req.method === 'GET') return json(res, 200, store.load().sources);
    if (u === '/concepts' && req.method === 'GET') return json(res, 200, store.load().concepts);
    if (u === '/analyze' && req.method === 'POST') return json(res, 200, startAnalyze(await readBody(req)));
    if (u === '/analyze-status' && req.method === 'GET') {
      const id = new URLSearchParams(req.url.split('?')[1] || '').get('id');
      const j = jobs[id] || { status: 'unknown' };
      return json(res, 200, { status: j.status, result: j.result, error: j.error });
    }
    if (u === '/generate' && req.method === 'POST') return json(res, 200, await handleGenerate(await readBody(req)));
    if (u === '/concept-sheet' && req.method === 'POST') return json(res, 200, await handleConceptSheet(await readBody(req)));
    if (u === '/assets' && req.method === 'GET') return json(res, 200, store.load().assets);
    if (u === '/asset-upload' && req.method === 'POST') return json(res, 200, await handleAssetUpload(await readBody(req)));
    if (u === '/asset-delete' && req.method === 'POST') return json(res, 200, await handleAssetDelete(await readBody(req)));
    if (u === '/market' && req.method === 'GET') return json(res, 200, store.load().market);
    if (u === '/market-add' && req.method === 'POST') return json(res, 200, await handleMarketAdd(await readBody(req)));
    if (u === '/market-import-sources' && req.method === 'POST') return json(res, 200, await handleMarketImportSources());
    if (u === '/market-delete' && req.method === 'POST') return json(res, 200, await handleMarketDelete(await readBody(req)));
    if (u === '/template-merge' && req.method === 'POST') return json(res, 200, await handleTemplateMerge(await readBody(req)));
    if (u === '/scan-video' && req.method === 'POST') return json(res, 200, await handleScanVideo(req));
    if (u === '/scan-selftest' && req.method === 'GET') {
      // Diagnostic : compose le scan sur un clip GÉNÉRÉ (pas d'upload) → révèle
      // si ffmpeg/overlay tourne sur cet environnement (Render) et pourquoi pas.
      fs.mkdirSync(TMP, { recursive: true });
      const tin = path.join(TMP, 'selftest_in.mp4');
      const tout = path.join(TMP, 'selftest_out.mp4');
      const g = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=24:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', tin], { stdio: 'ignore' });
      const rr = await compositeScan(tin, tout);
      const ok = rr.code === 0 && fs.existsSync(tout) && fs.statSync(tout).size > 0;
      const outSize = fs.existsSync(tout) ? fs.statSync(tout).size : 0;
      try { fs.unlinkSync(tin); } catch {}
      try { fs.unlinkSync(tout); } catch {}
      return json(res, 200, { ok, ffmpeg: !!ffmpeg, scanfxExists: fs.existsSync(SCANFX), genCode: g.status, code: rr.code, outSize, stderrTail: (rr.stderr || '').slice(-700) });
    }
    if (u === '/scanfx.apng' && (req.method === 'GET' || req.method === 'HEAD')) {
      // Aperçu animé de l'overlay (tuile « Animation d'analyse » côté créateur).
      if (!fs.existsSync(SCANFX)) return json(res, 404, { error: 'overlay absent' });
      const stat = fs.statSync(SCANFX);
      res.writeHead(200, { 'content-type': 'image/apng', 'cache-control': 'public, max-age=86400', 'content-length': stat.size });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(SCANFX).pipe(res);
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(req.url, '→', e.message);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const db = store.load();
  console.log(`\n🧪 Creatikk — outil concepts sur http://localhost:${PORT}`);
  console.log(`   Claude ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌'} · Groq ${process.env.GROQ_API_KEY ? '✅' : '⚠️'} · TikTok ${process.env.RAPIDAPI_KEY ? 'RapidAPI' : 'tikwm'}`);
  console.log(`   mémoire : ${db.templates.length} templates · ${db.sources.length} sources · ${db.concepts.length} concepts\n`);
});
