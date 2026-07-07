// ─── Brique 3 : extraire des images clés (ffmpeg) → base64 ─────────
// Échantillonnage INTELLIGENT : on densifie le hook (0-3s, le plus
// déterminant), on répartit le reste jusqu'à la fin, et on mesure le
// nombre de coupes (rythme de montage) — un signal viral qu'une image
// seule ne montre pas.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

// Timestamps : quelques images serrées sur le hook + le reste étalé.
function buildTimestamps(dur, n) {
  const hookN = Math.min(3, n);
  const hookEnd = Math.max(1, Math.min(3, dur * 0.25));
  const ts = [];
  for (let i = 0; i < hookN; i++) ts.push((hookEnd * (i + 0.5)) / hookN);
  const restN = n - hookN;
  for (let i = 0; i < restN; i++) ts.push(hookEnd + ((dur - hookEnd) * (i + 0.5)) / restN);
  return ts;
}

function extractFrames(filePath, durationSec, n = 12) {
  const dur = durationSec && durationSec > 0 ? durationSec : 15;
  const dir = path.join(path.dirname(filePath), 'frames_' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  let out = [];
  try {
    // UN SEUL passage ffmpeg (bien plus rapide sur petit CPU qu'un lancement
    // par image) : n images réparties sur toute la durée.
    execFileSync(ffmpeg, ['-i', filePath, '-vf', `fps=${n}/${dur.toFixed(2)},scale=512:-1`, '-frames:v', String(n), '-q:v', '4', '-y', path.join(dir, 'f_%03d.jpg')], { stdio: 'ignore' });
    out = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => fs.readFileSync(path.join(dir, f)).toString('base64'));
  } catch {
    /* extraction ratée → on continue sans images */
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return out;
}

// Compte les changements de plan (rythme de montage).
function countCuts(filePath) {
  try {
    const r = spawnSync(ffmpeg, ['-i', filePath, '-filter:v', "select='gt(scene,0.35)',showinfo", '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
    const s = r.stderr || '';
    return (s.match(/pts_time:/g) || []).length;
  } catch {
    return null;
  }
}

module.exports = { extractFrames, countCuts };
