// ─── Brique 2 : transcription du son (Groq Whisper, gratuit) ───────
// Whisper accepte directement le mp4. Toute langue. Renvoie null si
// pas de clé (l'outil bascule alors sur le collage manuel).
const fs = require('fs');

async function transcribe(filePath) {
  if (!process.env.GROQ_API_KEY) return null;
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), 'audio.mp4');
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'json');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
    body: form,
  });
  if (!res.ok) throw new Error('Groq ' + res.status + ': ' + (await res.text()));
  const j = await res.json();
  return (j.text || '').trim();
}

module.exports = { transcribe };
