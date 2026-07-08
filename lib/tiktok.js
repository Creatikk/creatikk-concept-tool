// ─── Brique 1 : récupérer la vidéo + les stats depuis un lien ──────
// Par défaut : API publique gratuite tikwm (suffit pour tester).
// Si RAPIDAPI_KEY est défini : passe par RapidAPI (plus fiable).
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

async function fetchInfo(url) {
  if (process.env.RAPIDAPI_KEY && process.env.RAPIDAPI_HOST) {
    return fetchViaRapidApi(url);
  }
  return fetchViaTikwm(url);
}

async function fetchViaTikwm(url) {
  const api = 'https://www.tikwm.com/api/?hd=1&url=' + encodeURIComponent(url);
  const call = async () => {
    const res = await fetch(api, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error('tikwm ' + res.status);
    return res.json();
  };
  let j = await call();
  // tikwm gratuit = 1 requête/seconde : on retente une fois si limite atteinte
  if (j.code !== 0 && /limit/i.test(j.msg || '')) { await new Promise((r) => setTimeout(r, 1500)); j = await call(); }
  if (j.code !== 0 || !j.data) throw new Error('tikwm: ' + (j.msg || 'lien illisible'));
  const d = j.data;
  const videoUrl = d.hdplay || d.play || d.wmplay;
  if (!videoUrl) throw new Error('tikwm: pas d\'URL vidéo');
  return {
    videoUrl: videoUrl.startsWith('http') ? videoUrl : 'https://www.tikwm.com' + videoUrl,
    meta: {
      author: d.author?.unique_id || d.author?.nickname || null,
      title: d.title || null,
      views: d.play_count ?? null,
      likes: d.digg_count ?? null,
      comments: d.comment_count ?? null,
      shares: d.share_count ?? null,
      duration: d.duration ?? null,
      music: d.music_info?.title || null,
      cover: d.cover || null,
      postDate: d.create_time ? new Date(d.create_time * 1000).toISOString() : null,
    },
  };
}

// Gabarit RapidAPI — à ajuster selon l'API choisie (les champs varient).
async function fetchViaRapidApi(url) {
  const endpoint = `https://${process.env.RAPIDAPI_HOST}/?url=${encodeURIComponent(url)}`;
  const res = await fetch(endpoint, {
    headers: {
      'x-rapidapi-key': process.env.RAPIDAPI_KEY,
      'x-rapidapi-host': process.env.RAPIDAPI_HOST,
    },
  });
  if (!res.ok) throw new Error('RapidAPI ' + res.status);
  const j = await res.json();
  const d = j.data || j;
  const videoUrl = d.hdplay || d.play || d.video || d.url;
  if (!videoUrl) throw new Error('RapidAPI : pas d\'URL vidéo (ajuster le mapping dans tiktok.js)');
  return {
    videoUrl,
    meta: {
      author: d.author?.unique_id || d.author || null,
      title: d.title || d.desc || null,
      views: d.play_count ?? d.views ?? null,
      likes: d.digg_count ?? d.likes ?? null,
      duration: d.duration ?? null,
      music: d.music_info?.title || d.music || null,
      cover: d.cover || null,
    },
  };
}

async function downloadTo(videoUrl, destPath) {
  const res = await fetch(videoUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tiktok.com/' } });
  if (!res.ok || !res.body) throw new Error('download ' + res.status);
  // Streaming DIRECT vers le disque (pas de arrayBuffer) : la vidéo ne passe
  // jamais en entier par la RAM → évite le dépassement mémoire sur Render (512 Mo).
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  return destPath;
}

// Récupère les commentaires les plus likés (signal de viralité : ce qui a
// fait réagir le public). Renvoie [] en cas d'échec (jamais bloquant).
async function fetchComments(url, n = 15) {
  try {
    const api = 'https://www.tikwm.com/api/comment/list/?count=30&cursor=0&url=' + encodeURIComponent(url);
    const res = await fetch(api, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];
    const j = await res.json();
    const cs = (j.data && j.data.comments) || [];
    return cs
      .map((c) => ({ text: (c.text || '').trim(), likes: c.digg_count || 0 }))
      .filter((c) => c.text)
      .sort((a, b) => b.likes - a.likes)
      .slice(0, n);
  } catch {
    return [];
  }
}

module.exports = { fetchInfo, downloadTo, fetchComments };
