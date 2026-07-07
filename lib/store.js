// ─── Mémoire structurée : templates / sources / concepts ───────────
// - templates = les FORMULES virales (le cœur, se consolident)
// - sources   = les vidéos analysées (preuves rattachées à un template)
// - concepts  = les productions Creatikk (cycle de vie : idée→donné→publié)
const fs = require('fs');
const path = require('path');

// DATA_DIR = disque persistant en prod (Render), ./data en local.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    d.templates ||= [];
    d.sources ||= [];
    d.concepts ||= [];
    d.assets ||= [];
    return d;
  } catch {
    return { templates: [], sources: [], concepts: [] };
  }
}

function save(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

module.exports = { load, save, genId };
