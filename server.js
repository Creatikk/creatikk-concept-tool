// ───────────────────────────────────────────────────────────────────
// Creatikk — Outil interne d'analyse de concepts viraux.
// Écosystème : Sources → (analyse) → Templates (mémoire) →
// (génération par niche) → Concepts → (résultats) → renforce Templates.
// Démarrage : node server.js   (port 8790)
// ───────────────────────────────────────────────────────────────────
const http = require('http');
const fs = require('fs');
const path = require('path');

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

const { callClaude, buildAnalyze, buildClassify, buildGenerate, buildConceptSheet, buildAdaptations } = require('./lib/claude');
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

  const analysis = await callClaude({ ...buildAnalyze({ meta: info.meta, transcript, framesB64 }), maxTokens: 4500 });

  const db = store.load();
  // Fusion : ce concept correspond-il à un template connu ?
  const cls = await callClaude(buildClassify({ sujet: analysis.sujet, templateReutilisable: analysis.templateReutilisable, existing: db.templates }));
  let template = cls.match && cls.templateId ? db.templates.find((t) => t.id === cls.templateId) : null;
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
      if (!t2.fiche) { try { t2.fiche = await callClaude(buildConceptSheet({ template: t2, sources: d2.sources.filter((s) => s.templateId === tid) })); } catch (e) { console.error('fiche bg →', e.message); } }
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

const server = http.createServer(async (req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (req.method === 'GET' && (u === '/' || u === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (req.method === 'GET' && u.startsWith('/assets/')) {
      const fp = path.join(ASSETS_DIR, path.basename(u));
      if (fs.existsSync(fp)) { res.writeHead(200, { 'content-type': MIME[fp.split('.').pop().toLowerCase()] || 'application/octet-stream' }); return res.end(fs.readFileSync(fp)); }
      return json(res, 404, { error: 'asset introuvable' });
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
