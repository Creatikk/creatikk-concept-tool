// ─── Cerveau : analyse multimodale + génération de concepts ────────
// Réutilise le pattern éprouvé du serveur cerveau démo (JSON forcé +
// retry anti-troncature), étendu à la VISION (images extraites).
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

async function callClaude({ system, content, schema, maxTokens = 4000 }) {
  const started = Date.now();
  const once = async (budget) => {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: budget,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
        output_config: { format: { type: 'json_schema', schema } },
      }),
    });
    if (!res.ok) throw new Error('Anthropic ' + res.status + ': ' + (await res.text()));
    return res.json();
  };
  let data = await once(maxTokens);
  console.error('[claude] appel 1 :', ((Date.now() - started) / 1000).toFixed(1) + 's', '· stop=' + data.stop_reason, '· out=' + (data.usage && data.usage.output_tokens), '· in=' + (data.usage && data.usage.input_tokens));
  if (data.stop_reason === 'refusal') throw new Error('REFUSAL');
  if (data.stop_reason === 'max_tokens') {
    data = await once(Math.min(maxTokens * 2, 8000));
    console.error('[claude] appel 2 (retry) :', ((Date.now() - started) / 1000).toFixed(1) + 's total');
  }
  const block = (data.content || []).find((b) => b.type === 'text');
  return JSON.parse(block ? block.text : '{}');
}

// ── Ce que Creatikk sait faire (pour caler les adaptations) ─────────
const CREATIKK = `Creatikk (creatikk.io) = la boîte à outils IA complète du créateur de contenu court. Ce qu'il sait faire (nouvelle version) :
- Génération de script : écrit un script viral prêt à filmer (30/60/90 s).
- Studio (montage vidéo) : transforme un script en vidéo montée — clips de banque + voix off (Standard) ; ou vidéo 100% générée par IA au style choisi (cartoon, réaliste…) ; clips IA premium (VEO 3, Sora 2, Kling, WAN) ; animer une image fixe ; restyler une vidéo existante ; Motion control (poser un visage/avatar sur une vidéo — idéal faceless).
- Analyse vidéo : teste TA vidéo avant/après publication, et analyse celle d'un CONCURRENT (hook, rétention, pourquoi ça marche).
- Trend : les vidéos les plus vues par pays/niche, pour trouver quoi poster.
- SmartPost : publier sur tous tes réseaux d'un coup depuis Creatikk.
- Finder de niche : trouver sa niche quand c'est flou.`;

const STRUCTURE = `STRUCTURE OBLIGATOIRE de chaque concept — c'est CETTE mécanique qui rend ces vidéos virales, ne JAMAIS la court-circuiter :
1. HOOK (0-3s) : nomme une douleur ou un désir précis du spectateur.
2. VALEUR GRATUITE D'ABORD : donne une VRAIE astuce actionnable et gratuite, que le spectateur peut appliquer IMMÉDIATEMENT et SANS Creatikk (ex : une fonctionnalité cachée de la plateforme, une technique concrète, une méthode). C'est ce qui crée la confiance, le save et le partage. INTERDIT de mentionner Creatikk AVANT d'avoir livré cette valeur. INTERDIT de sauter cette étape.
3. PIVOT NATUREL : SEULEMENT APRÈS, enchaîne "et si tu veux aller plus loin / faire ça à grande échelle / gagner du temps, l'outil que j'utilise c'est Creatikk…" avec le bénéfice concret.
4. CTA discret : "lien en bio", "dis-moi si ça t'a aidé".
Creatikk est le HÉROS DISCRET : jamais une pub frontale "abonne-toi à Creatikk". On vend un résultat, l'app est le moyen.
L'outil promu est TOUJOURS Creatikk. Si la vidéo source promeut un autre outil, remplace-le par Creatikk. N'écris JAMAIS le nom d'un outil concurrent dans ta réponse (pas même pour dire de l'éviter).
Pour le PIVOT/CTA : choisis UNE SEULE feature Creatikk, celle qui colle le mieux à CE concept précis, et VARIE d'un concept à l'autre — ne renvoie PAS toujours vers la génération de script. Exemples d'appariement : concept "trouver des idées / ce qui cartonne" → Trend ; faceless / montage / avatar → Studio (voix off, clips IA, Motion control) ; "analyser/améliorer ses vidéos ou espionner un concurrent" → Analyse vidéo ; "poster partout sans effort" → SmartPost ; "je sais pas quoi dire" → Génération de script ; "je sais pas quelle niche" → Finder de niche.
Le champ scriptVerbatim doit contenir le TEXTE COMPLET à dire, mot pour mot, du premier au dernier mot, en langage parlé naturel (pas d'indication technique dedans). Les indications visuelles vont dans notesTournage.`;

const SYSTEM_ANALYZE = `Tu es l'analyste de concepts viraux de Creatikk — un outil INTERNE d'acquisition. Tu reçois une vidéo courte (TikTok/Reel/Short) qui a marché (ou pas) quelque part dans le monde : ses statistiques, la TRANSCRIPTION de son audio (dans sa langue d'origine), et des IMAGES extraites de la vidéo — tu peux donc VOIR le montage, le texte à l'écran, le style, le rythme.

Ta mission : décortiquer POURQUOI ça marche ou pas, en extraire un TEMPLATE réutilisable, et proposer des adaptations pour Creatikk.

Règles :
- Réponds TOUJOURS en FRANÇAIS, même si la source est en anglais ou autre langue (tu traduis nativement).
- Sois ULTRA concret et spécifique à CETTE vidéo : cite le hook réel entendu, décris ce que tu VOIS à l'écran (texte, plan, montage). Zéro généralité qu'on lirait n'importe où.
- Croise les signaux : le SON (script/paroles + musique/tempo), le VISUEL (images), les STATS, et les COMMENTAIRES les plus likés. Explique le mécanisme, pas juste un verdict.
- Les COMMENTAIRES les plus likés révèlent ce qui a fait réagir/débattre/partager (souvent LA vraie raison de la viralité) : intègre-les à ton analyse de viralité, au mécanisme psychologique ET au template réutilisable. Ne les ignore jamais.
- Le TEMPLATE réutilisable est le livrable clé : la FORMULE abstraite qu'on peut répéter en boucle avec d'autres sujets.
- scriptSource : reconstitue le déroulé chronologique COMPLET de la vidéo source (ce qui est dit mot pour mot ET ce qu'on voit), à partir de la transcription et des images. C'est le "script + visuel" de la vidéo d'origine.
- ${CREATIKK}`;

const ANALYZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    langueSource: { type: 'string', description: 'langue d\'origine détectée (ex: anglais US)' },
    sujet: { type: 'string', description: 'de quoi parle la vidéo en 1 phrase' },
    viralite: {
      type: 'object',
      additionalProperties: false,
      properties: {
        score: { type: 'integer', description: 'potentiel viral 0-100' },
        verdict: { type: 'string', description: 'viral / correct / faible, en 1 mot + nuance' },
        pourquoi: { type: 'string', description: '2-3 phrases : le vrai moteur (ou le frein)' },
      },
      required: ['score', 'verdict', 'pourquoi'],
    },
    hook: { type: 'string', description: 'le hook réel des 0-3s (cite-le)' },
    angle: { type: 'string', description: 'le désir/la tension activé' },
    structure: { type: 'string', description: 'le squelette narratif' },
    mecanismePsy: { type: 'string', description: 'pourquoi le cerveau accroche' },
    visuel: { type: 'string', description: 'ce que tu vois : montage, texte à l\'écran, plans, rythme des coupes' },
    son: { type: 'string', description: 'voix/ton + musique/tempo et leur rôle' },
    integrationProduit: { type: 'string', description: 'comment un outil/produit apparaît (ou pourrait apparaître) sans casser le naturel' },
    format: { type: 'string', description: 'faceless/visage, durée, screen-record, voix off…' },
    cta: { type: 'string', description: 'ce qui pousse à l\'action / vers la bio' },
    templateReutilisable: { type: 'string', description: 'LA formule abstraite répétable en boucle' },
    risques: { type: 'array', items: { type: 'string' }, description: 'pièges si on copie mal' },
    reactionsCommentaires: { type: 'string', description: 'ce que révèlent les commentaires les plus likés : ce qui a fait réagir, les objections, ce qui a poussé à commenter/partager — et en quoi ça explique (ou pas) la viralité. "(pas de commentaires)" si non fournis.' },
    scriptSource: {
      type: 'array',
      description: 'le déroulé chronologique de la vidéo source, segment par segment : ce qui est DIT (mot pour mot) et ce qu\'on VOIT à l\'écran. Reconstruit depuis la transcription + les images.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          moment: { type: 'string', description: 'repère temporel, ex "0-3s"' },
          dit: { type: 'string', description: 'ce qui est dit mot pour mot (traduit en FR si autre langue, sens exact conservé)' },
          vu: { type: 'string', description: 'ce qu\'on voit à l\'écran à ce moment (plan, texte à l\'écran, overlay)' },
        },
        required: ['moment', 'dit', 'vu'],
      },
    },
  },
  required: ['langueSource', 'sujet', 'viralite', 'hook', 'angle', 'structure', 'mecanismePsy', 'visuel', 'son', 'integrationProduit', 'format', 'cta', 'templateReutilisable', 'risques', 'reactionsCommentaires', 'scriptSource'],
};

function buildAnalyze({ meta, transcript, framesB64, comments }) {
  const cutInfo = meta.cuts != null ? ` · ${meta.cuts} coupe(s) détectée(s) → montage ${meta.cuts >= 12 ? 'très nerveux' : meta.cuts >= 5 ? 'rythmé' : 'lent'}` : '';
  const stats = `STATS : @${meta.author || '?'} · ${meta.views ?? '?'} vues · ${meta.likes ?? '?'} likes · ${meta.duration ?? '?'}s · son : ${meta.music || '?'}${cutInfo}${meta.title ? '\nLÉGENDE : ' + meta.title : ''}`;
  const tr = transcript && transcript.trim() ? transcript.trim() : '(transcription indisponible — analyse surtout le visuel et les stats)';
  const framesNote = framesB64 && framesB64.length
    ? `${framesB64.length} images extraites suivent. Les 3 PREMIÈRES couvrent le HOOK (0-3s, le plus déterminant) ; les suivantes sont réparties jusqu'à la fin. Analyse le hook visuel en détail, puis le texte à l'écran, le style et le rythme (croise avec le nombre de coupes ci-dessus).`
    : '(pas d\'images fournies)';
  const commentsNote = comments && comments.length
    ? `\n\nCOMMENTAIRES LES PLUS LIKÉS (réaction du public — souvent LA vraie raison de la viralité) :\n${comments.map((c) => `[${c.likes} likes] ${c.text}`).join('\n')}`
    : '\n\n(commentaires non disponibles)';
  const text = `Analyse cette vidéo courte.\n\n${stats}\n\nTRANSCRIPTION (langue d'origine) :\n"""${tr}"""${commentsNote}\n\n${framesNote}`;
  const content = [{ type: 'text', text }];
  for (const b64 of framesB64 || []) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
  }
  return { system: SYSTEM_ANALYZE, content, schema: ANALYZE_SCHEMA };
}

// ── Le bibliothécaire : range chaque concept dans un template ───────
// (fusionne les doublons pour que la mémoire converge vers ~N formules)
const SYSTEM_CLASSIFY = `Tu es le bibliothécaire des templates viraux de Creatikk. Ton job : ranger chaque vidéo analysée dans la BONNE formule (template), en fusionnant les doublons.

Deux vidéos partagent un template si elles reposent sur la MÊME mécanique de fond (même type de hook + même ressort psychologique), même si le sujet diffère. Ex : "voilà l'astuce que personne ne te dit" et "voilà ce que les pros cachent" = même template (secret d'insider).

Sois STRICT sur la fusion (évite de multiplier des quasi-doublons), mais ne force pas ensemble deux mécaniques vraiment différentes. Réponds en français.`;

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    match: { type: 'boolean', description: 'true si ça correspond à un template existant' },
    templateId: { type: ['string', 'null'], description: 'id du template existant si match, sinon null' },
    nom: { type: 'string', description: 'nom court et évocateur (utile même en cas de match, pour référence)' },
    formule: { type: 'string', description: 'la formule abstraite réutilisable' },
    ressorts: { type: 'string', description: 'les ressorts psychologiques en jeu' },
    formatType: { type: 'string', description: 'format type (faceless/visage, durée, screen…)' },
    niches: { type: 'array', items: { type: 'string' }, description: '2 à 4 niches où ce template marche' },
  },
  required: ['match', 'templateId', 'nom', 'formule', 'ressorts', 'formatType', 'niches'],
};

function buildClassify({ sujet, templateReutilisable, existing }) {
  const list = (existing || []).map((t) => `- id:${t.id} | ${t.nom} : ${t.formule}`).join('\n') || '(aucun template encore)';
  const text = `Vidéo analysée — sujet : ${sujet}\nSa formule : ${templateReutilisable}\n\nTEMPLATES EXISTANTS :\n${list}\n\nCette formule correspond-elle à un template existant ? Si oui : match=true + son templateId. Sinon : match=false, templateId=null, et propose nom / formule / ressorts / formatType / niches.`;
  return { system: SYSTEM_CLASSIFY, content: [{ type: 'text', text }], schema: CLASSIFY_SCHEMA };
}

// ── Génération de concepts à partir des TEMPLATES de la mémoire ─────
const SYSTEM_GENERATE = `Tu es le générateur de concepts viraux de Creatikk (outil interne). Tu pars de TEMPLATES réellement prouvés pour créer de NOUVEAUX concepts filmables par des créateurs débutants, dans la niche demandée.

Règles :
- Chaque concept est bâti sur un des templates fournis (indique lequel dans templateNom).
- Réponds en FRANÇAIS, concret.
- ${CREATIKK}
- Varie les angles et les formats. Pas de redites.

${STRUCTURE}`;

const GENERATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          titre: { type: 'string' },
          hook: { type: 'string', description: 'l\'accroche des 0-3s, mot pour mot' },
          astuceGratuite: { type: 'string', description: 'l\'astuce concrète, gratuite et actionnable donnée AVANT de mentionner Creatikk (cœur de la méthode)' },
          scriptVerbatim: { type: 'string', description: 'le script COMPLET mot pour mot, de A à Z, langage parlé, prêt prompteur : hook + astuce détaillée + pivot Creatikk + CTA. Aucune indication technique entre crochets.' },
          notesTournage: { type: 'string', description: 'indications visuelles séparées : plans, texte à l\'écran, overlays, B-roll' },
          format: { type: 'string' },
          templateNom: { type: 'string', description: 'le nom du template réutilisé' },
          pourquoiCaMarche: { type: 'string' },
        },
        required: ['titre', 'hook', 'astuceGratuite', 'scriptVerbatim', 'notesTournage', 'format', 'templateNom', 'pourquoiCaMarche'],
      },
    },
  },
  required: ['concepts'],
};

function buildGenerate({ niche, n, templates }) {
  const list = (templates || [])
    .map((t) => {
      let s = `- [${t.nom}] ${t.formule} — ressorts : ${t.ressorts || '?'} · force ${t.force} · niches : ${(t.niches || []).join(', ')}`;
      if (t.hookPatterns && t.hookPatterns.length) s += `\n    Hooks qui ont marché : ${t.hookPatterns.join(' | ')}`;
      if (t.pourquoiCaMarche) s += `\n    Pourquoi ça marche (réactions du public incluses) : ${t.pourquoiCaMarche}`;
      return s;
    })
    .join('\n');
  const text = `Niche : ${niche}\nNombre de concepts : ${n}\n\nTEMPLATES PROUVÉS (classés par force) :\n${list || '(mémoire vide — appuie-toi sur les grands ressorts viraux)'}\n\nGénère ${n} concepts distincts pour cette niche, chacun bâti sur un de ces templates (privilégie les plus forts et les plus adaptés à la niche). Quand un template fournit des « Hooks qui ont marché » ou un « Pourquoi ça marche », inspire-t'en DIRECTEMENT pour écrire le hook et le script mot pour mot — reprends les angles précis qui ont fait réagir le public.`;
  return { system: SYSTEM_GENERATE, content: [{ type: 'text', text }], schema: GENERATE_SCHEMA };
}

// ── Fiche concept transmissible à un créateur ──────────────────────
const SYSTEM_SHEET = `Tu es le formateur de Creatikk. À partir d'un TEMPLATE viral et de ses exemples réels, tu écris une FICHE CONCEPT claire, transmissible telle quelle à un créateur débutant qui va tourner la vidéo. Français, concret, actionnable, sans jargon.

Rappel de la structure gagnante : hook (douleur/désir) → VALEUR GRATUITE d'abord (vraie astuce sans Creatikk) → pivot vers Creatikk (héros discret) → CTA. La fiche doit refléter ça.
L'outil promu est TOUJOURS Creatikk. Si l'exemple source promeut un autre outil, remplace-le par Creatikk. N'écris JAMAIS le nom d'un outil concurrent dans ta réponse (pas même pour dire de l'éviter).
Pour le CTA : choisis UNE SEULE feature Creatikk adaptée à ce concept (pas toujours la génération de script — pense aussi à Studio, Analyse vidéo, Trend, SmartPost, Motion control, Finder de niche selon le sujet).`;

const SHEET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    logique: { type: 'string', description: 'pourquoi ce concept marche, en 2-3 phrases simples' },
    elementsAMontrer: { type: 'array', items: { type: 'string' }, description: 'ce qu\'on doit VOIR à l\'écran, étape par étape (plans, texte à l\'écran, démo)' },
    quoiDire: { type: 'array', items: { type: 'string' }, description: 'la trame de ce qu\'il faut DIRE, dans l\'ordre (hook → astuce gratuite → pivot Creatikk → CTA)' },
    aEviter: { type: 'array', items: { type: 'string' }, description: 'les erreurs qui tuent le concept' },
  },
  required: ['logique', 'elementsAMontrer', 'quoiDire', 'aEviter'],
};

function buildConceptSheet({ template, sources }) {
  const ex = (sources || []).map((s) => `- ${s.sujet} (${s.meta?.views ?? '?'} vues)`).join('\n') || '(pas d\'exemple)';
  const text = `TEMPLATE : ${template.nom}\nFormule : ${template.formule}\nRessorts : ${template.ressorts || '?'}\n\nEXEMPLES RÉELS de ce concept :\n${ex}\n\nÉcris la fiche concept transmissible à un créateur débutant qui va filmer une vidéo sur ce modèle.`;
  return { system: SYSTEM_SHEET, content: [{ type: 'text', text }], schema: SHEET_SCHEMA };
}

// ── Adaptations Creatikk (généré en tâche de fond, à partir de l'analyse) ──
const SYSTEM_ADAPT = `Tu es le créateur d'adaptations Creatikk. À partir de l'analyse d'une vidéo virale (sujet, formule, ressorts), tu écris 3 adaptations FR prêtes à filmer pour promouvoir Creatikk, chacune bâtie sur la formule de la vidéo.

${STRUCTURE}`;

const ADAPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    adaptations: {
      type: 'array',
      description: '3 adaptations FR prêtes à filmer',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          titre: { type: 'string' },
          hook: { type: 'string', description: 'accroche 0-3s, mot pour mot' },
          astuceGratuite: { type: 'string', description: 'astuce concrète, gratuite et actionnable donnée AVANT de mentionner Creatikk' },
          scriptVerbatim: { type: 'string', description: 'script COMPLET mot pour mot d\'une vidéo 30-45s (~120-180 mots), prêt prompteur : hook + astuce détaillée + pivot Creatikk + CTA. Aucune indication technique entre crochets.' },
          notesTournage: { type: 'string', description: 'indications visuelles : plans, texte à l\'écran, overlays, B-roll' },
          format: { type: 'string' },
        },
        required: ['titre', 'hook', 'astuceGratuite', 'scriptVerbatim', 'notesTournage', 'format'],
      },
    },
  },
  required: ['adaptations'],
};

function buildAdaptations({ analysis }) {
  const a = analysis;
  const reactions = a.reactionsCommentaires && !/^\(?\s*pas de comment/i.test(a.reactionsCommentaires.trim()) ? a.reactionsCommentaires.trim() : null;
  const text = `Vidéo virale analysée :\nSujet : ${a.sujet}\nFormule (template) : ${a.templateReutilisable}\nHook original : ${a.hook}\nRessort psychologique : ${a.mecanismePsy}\nComment un produit s'y intègre : ${a.integrationProduit}${reactions ? `\nCE QUI A FAIT RÉAGIR LE PUBLIC EN COMMENTAIRES : ${reactions}` : ''}\n\nÉcris 3 adaptations FR pour promouvoir Creatikk sur cette formule. Chacune : astuce gratuite RÉELLE avant Creatikk, script verbatim complet, et une feature Creatikk DIFFÉRENTE d'une adaptation à l'autre.${reactions ? ' IMPORTANT : dans le HOOK et le SCRIPT mot pour mot, reprends explicitement les angles, douleurs ou objections qui ont fait réagir le public en commentaires (ci-dessus) — c\'est souvent ce qui a vraiment déclenché le partage.' : ''}`;
  return { system: SYSTEM_ADAPT, content: [{ type: 'text', text }], schema: ADAPT_SCHEMA, maxTokens: 3500 };
}

// ── Raffineur : affine un template à partir de TOUTES ses vidéos ────
// (plus il y a de vidéos, plus la formule et les hooks sont précis)
const SYSTEM_REFINE = `Tu es le bibliothécaire-analyste des templates viraux de Creatikk. À partir de PLUSIEURS vidéos qui partagent une même formule, tu affines le template pour qu'il soit le plus PRÉCIS et ACTIONNABLE possible. Tu extrais ce qui est COMMUN (la mécanique qui revient), tu notes ce qui VARIE, et tu dégages les patterns de hook récurrents. Français, concret. Base-toi sur les vraies données (hooks réels, réactions des commentaires).`;

const REFINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    nom: { type: 'string', description: 'nom court et évocateur du template' },
    formule: { type: 'string', description: 'la formule commune la plus précise, tirée de TOUTES les vidéos' },
    ressorts: { type: 'string', description: 'les ressorts psychologiques récurrents' },
    hookPatterns: { type: 'array', items: { type: 'string' }, description: '2 à 5 structures de hook qui reviennent (chacune : la structure abstraite + un exemple concret tiré des vidéos)' },
    pourquoiCaMarche: { type: 'string', description: 'synthèse transversale : pourquoi cette formule cartonne (en tenant compte des réactions des commentaires)' },
    niches: { type: 'array', items: { type: 'string' }, description: '2 à 4 niches où ça marche' },
  },
  required: ['nom', 'formule', 'ressorts', 'hookPatterns', 'pourquoiCaMarche', 'niches'],
};

function buildRefineTemplate({ template, sources }) {
  const ex = (sources || []).map((s, i) => {
    const a = s.analysis || {};
    return `VIDÉO ${i + 1} — ${s.sujet || '?'} (${s.meta?.views ?? '?'} vues)\n  Hook : ${a.hook || '?'}\n  Mécanisme : ${a.mecanismePsy || '?'}\n  Réactions commentaires : ${a.reactionsCommentaires || '—'}`;
  }).join('\n\n');
  const text = `Template actuel : ${template.nom}\nFormule actuelle : ${template.formule}\n\nLes ${(sources || []).length} vidéos qui incarnent ce template :\n\n${ex}\n\nAffine le template à partir de TOUTES ces vidéos : la formule commune la plus précise, les ressorts, les HOOK PATTERNS récurrents (avec exemple concret), pourquoi ça marche (intègre les réactions des commentaires), et les niches.`;
  return { system: SYSTEM_REFINE, content: [{ type: 'text', text }], schema: REFINE_SCHEMA, maxTokens: 2000 };
}

module.exports = { callClaude, buildAnalyze, buildClassify, buildGenerate, buildConceptSheet, buildAdaptations, buildRefineTemplate };
