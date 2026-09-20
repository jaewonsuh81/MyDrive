/**
 * MyDrive — language service endpoint
 *
 * The browser never sees an API key. It posts { mode, text, sentence, lang }
 * and gets back parsed JSON. Everything model-specific lives below the
 * `providers` boundary, so swapping Gemini for another vendor is a one-line
 * env change (LLM_PROVIDER) plus one function.
 *
 * Environment variables (set in Vercel → Settings → Environment Variables):
 *   GEMINI_API_KEY   required
 *   GEMINI_MODEL     optional, e.g. gemini-2.5-flash
 *   LLM_PROVIDER     optional, "gemini" (default) or "anthropic"
 *   ANTHROPIC_API_KEY  only if LLM_PROVIDER=anthropic
 *
 * GET /api/lookup  →  health check: shows which provider is configured and
 *                     which models the key can actually reach.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_TEXT = 6000;      // cost guard (writing feedback needs more room)
const MAX_BRIEFING = 24000; // a briefing is long by nature
const MAX_SENTENCE = 1200;
const MAX_CHAT_CONTEXT = 60000; // a short paper/chapter fits whole; longer docs are pre-filtered client-side
const MAX_HISTORY = 6000;       // last few turns of a chat, not the whole thread

const SYSTEM =
  'You are a bilingual English–Korean reading assistant inside a personal knowledge app ' +
  'for a Korean engineering student. Write meanings and explanations in Korean unless told ' +
  'otherwise. Be precise and concise. Output raw JSON only — no markdown fences, no commentary.';

/* ---------------------------------------------------------------- prompts
   Single source of truth. Adding a mode = adding one entry here and one
   button in the reader. Nothing else changes.                             */
const PROMPTS = {
  term: (text, sentence, lang) => `TASK: term lookup
SELECTED: ${JSON.stringify(text)}
SENTENCE: ${JSON.stringify(sentence)}
SOURCE_LANGUAGE: ${lang}

Return JSON ("" where a field does not apply):
{"term":str,"lang":"en"|"ko","pos":str,"pron":str,"contextual":str,"general":str,
 "en":str,"hanja":str,"sentence_ko":str,"example":str,"example_ko":str,
 "concept":str,"tags":[str]}

contextual = 이 문장 안에서의 의미 (한국어)
general    = 일반적인 사전 의미 (한국어, 쉼표 구분)
en         = 한국어 단어일 때 대응하는 영어 표현
hanja      = 한자어일 때 한자
sentence_ko= SENTENCE 전체의 자연스러운 한국어 번역
concept    = 저장할 가치가 있는 기술/학술 개념이면 표준 명칭, 아니면 ""
tags       = 1~3개, 영어 소문자 한 단어 (academic, phrasal, collocation, technical, idiom 등)`,

  passage: (text, sentence, lang) => `TASK: passage translation
SELECTED: ${JSON.stringify(text)}
SOURCE_LANGUAGE: ${lang}

Return JSON:
{"translation":str,"gist":str,"terms":[{"term":str,"meaning":str}]}

translation = 직역이 아니라 자연스러운 한국어 의역. 원문이 한국어면 쉬운 한국어로 풀어쓴다.
gist        = 요지 한 문장
terms       = 이 구절의 핵심 표현 최대 4개`,

  briefing: (text) => `TASK: split a daily news briefing into a reading checklist
BRIEFING:
${text}

Return JSON:
{"summary":str,"items":[{"source":str,"title":str,"gist":str,"why":str}]}

summary = 오늘 흐름을 3~4문장으로, 한국어. 개별 기사 나열이 아니라 큰 그림.
items   = 실제로 읽을 가치가 있는 기사만 4~8개. 중복 주제는 하나로 합친다.
source  = 언론사명. 없으면 추정하지 말고 "".
title   = 기사 제목. 영문 기사면 영문 그대로 둔다.
gist    = 한 문장 요약, 한국어.
why     = 이 사람이 왜 읽어야 하는지 한 구절. 공학/AI/투자 관점을 우선한다.`,

  explain: (text, sentence) => `TASK: simple explanation
SELECTED: ${JSON.stringify(text)}
SENTENCE: ${JSON.stringify(sentence)}

Return JSON: {"explanation":str,"analogy":str}
explanation = 배경지식이 없어도 이해할 수 있게 2~3문장, 한국어
analogy     = 짧은 비유 하나, 없으면 ""`,

  /* Writing practice. The point is not a score but a usable correction:
     what was wrong, what a native writer would have put, and one thing to
     carry into the next sentence. */
  critique: (text, sentence) => `TASK: correct one learner sentence
TARGET_WORD: ${JSON.stringify(sentence)}
LEARNER_SENTENCE: ${JSON.stringify(text)}

Return JSON:
{"ok":true|false,"corrected":str,"note":str,"why":str}

ok        = 문법과 용법이 모두 자연스러우면 true
corrected = 원어민이 쓸 법한 문장. 고칠 것이 없으면 원문 그대로
note      = 무엇을 왜 고쳤는지 한국어 한두 문장. 고칠 것이 없으면 왜 좋은지
why       = 다음 문장에 적용할 규칙 한 줄, 한국어`,

  essay: (text, sentence) => `TASK: give feedback on a short piece of learner writing
PROMPT: ${JSON.stringify(sentence)}
LEARNER_TEXT: ${JSON.stringify(text)}

Return JSON:
{"corrected":str,"note":str,"why":str,"good":str}

corrected = 전체를 자연스러운 영어로 다시 쓴 것. 학습자의 논지와 길이는 유지한다
note      = 반복되는 오류 패턴 2~3개, 한국어
why       = 다음에 쓸 때 지킬 규칙 한 줄, 한국어
good      = 학습자가 잘한 점 한 가지, 한국어`,

  deep: (text, sentence) => `TASK: in-depth explanation
SELECTED: ${JSON.stringify(text)}
SENTENCE: ${JSON.stringify(sentence)}

Return JSON: {"explanation":str,"analogy":str}
explanation = 왜 그런지, 어떤 원리가 작동하는지까지 3~5문장, 한국어
analogy     = 짧은 비유 하나, 없으면 ""`,

  /* Document-grounded chat. `text` carries the document (or, for long
     documents, the client's best guess at the relevant slice of it — see
     pickRelevantBlocks in the reader). Putting the big, mostly-repeated
     document first and the changing turn last matches how Gemini's implicit
     caching looks for a matching prefix, so a multi-turn conversation about
     the same document gets cheaper as it goes on, with no extra code here. */
  chat: (text, sentence, lang, history) => `TASK: answer the reader's latest question about the document below
DOCUMENT (may be a filtered excerpt, not the full text):
${text}

CONVERSATION SO FAR (last line is the question to answer):
${history || '(none yet)'}

Return JSON: {"answer":str,"basis":str}
answer = 마지막 질문에 대한 답, 한국어. 이 문서 내용에 근거해서만 답하고, 문서에 없는 내용이면 없다고 말한다.
basis  = 답의 근거가 된 문서 속 구절을 짧게 그대로 인용 (없으면 "")`,
};

/* -------------------------------------------------------------- providers */
const providers = {
  async gemini({ system, prompt }) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not set in Vercel');

    // Model names move around; try the configured one, then known fallbacks.
    const candidates = [
      process.env.GEMINI_MODEL,
      'gemini-2.5-flash',
      'gemini-flash-latest',
      'gemini-3-flash-preview',
      'gemini-2.5-flash-lite',
    ].filter(Boolean);

    let lastError, waited = false;
    // The same model twice, then progressively lighter ones: a busy model is
    // usually only busy for a moment.
    const plan = [candidates[0], ...candidates];
    for (const model of plan) {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              // Thinking is billed against the output budget. A dictionary
              // lookup does not need it, and leaving it on lets the model burn
              // the whole allowance before writing a single character.
              maxOutputTokens: 8192,
              responseMimeType: 'application/json',
              ...thinkingConfigFor(model),
            },
          }),
        }
      );

      if (r.ok) {
        const j = await r.json();
        const cand = j.candidates?.[0];
        const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
        if (text.trim()) return text;
        // Empty body: say why, instead of silently moving on.
        lastError = new Error(
          `${model} returned nothing (finishReason=${cand?.finishReason || 'none'}` +
            `${j.promptFeedback?.blockReason ? ', blocked=' + j.promptFeedback.blockReason : ''})`
        );
        continue;
      }

      const body = await r.text();
      // 503 means the model is busy, not that anything is wrong. Waiting once
      // and then trying a lighter model recovers almost every time.
      if (r.status === 503 || r.status === 500) {
        if (!waited) { waited = true; await sleep(1200); lastError = new Error(`${model} busy`); }
        else lastError = new Error(`${model} busy`);
        continue;
      }
      if (r.status === 429) {
        throw new Error('무료 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요.');
      }
      if (r.status === 400 && /API key not valid/i.test(body)) {
        throw new Error('GEMINI_API_KEY 값이 올바르지 않습니다.');
      }
      if (r.status === 404 || /not found|not supported/i.test(body)) {
        lastError = new Error(`model ${model} unavailable`);
        continue; // try the next model name
      }
      throw new Error(`Gemini ${r.status}: ${body.slice(0, 180)}`);
    }
    throw new Error(
      lastError && /busy/.test(lastError.message)
        ? '모델이 혼잡합니다. 잠시 후 다시 시도하세요.'
        : lastError?.message || 'No usable Gemini model'
    );
  },

  async anthropic({ system, prompt }) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 180)}`);
    const j = await r.json();
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  },
};

/* Gemini 2.5 lets thinking be switched off outright; Gemini 3 only lets it be
   turned down. Anything else gets no thinking config at all. */
function thinkingConfigFor(model) {
  if (/^gemini-2\.5/.test(model)) return { thinkingConfig: { thinkingBudget: 0 } };
  if (/^gemini-3/.test(model)) return { thinkingConfig: { thinkingLevel: 'low' } };
  return {};
}

/* ---------------------------------------------------------------- helpers */
function parseJSON(raw) {
  const cleaned = String(raw).replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s !== -1 && e > s) {
      try {
        return JSON.parse(cleaned.slice(s, e + 1));
      } catch {
        /* fall through */
      }
    }
    return { explanation: cleaned.slice(0, 600) }; // never lose the answer entirely
  }
}

async function probe(res, providerName) {
  const out = { mode: 'probe', provider: providerName };
  try {
    const raw = await providers[providerName]({
      system: SYSTEM,
      prompt: PROMPTS.term('substantially', 'It substantially reduces cost.', 'en'),
    });
    out.rawFirst200 = String(raw).slice(0, 200);
    out.parsed = parseJSON(raw);
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = e.message;
  }
  return res.status(200).json(out);
}

async function health(res, providerName) {
  const key = process.env.GEMINI_API_KEY;
  const out = {
    ok: true,
    provider: providerName,
    geminiKey: key ? 'set' : 'MISSING',
    model: process.env.GEMINI_MODEL || '(auto)',
  };
  if (key) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': key },
      });
      const j = await r.json();
      out.availableModels = (j.models || [])
        .map((m) => String(m.name).replace('models/', ''))
        .filter((n) => n.includes('flash'))
        .slice(0, 12);
    } catch (e) {
      out.availableModels = 'lookup failed: ' + e.message;
    }
  }
  return res.status(200).json(out);
}

/* A public endpoint with a billable key behind it is somebody else's free
   API. Two cheap guards: reject cross-site callers, and cap the burst rate a
   single address can produce. Neither costs a database.

   40/min was sized for occasional lookups, not for hovering across a page
   while actually reading — a real reading pace alone can call for a dozen-
   plus translations a minute, and this is a single-person deployment behind
   a private URL (the cross-site check above is what actually keeps a
   stranger's script off it), so the risk a much higher ceiling adds is
   small next to how often 40 was getting hit by ordinary use. */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const max = 120;
  const rec = hits.get(ip);
  if (!rec || now - rec.start > windowMs) {
    hits.set(ip, { start: now, n: 1 });
    if (hits.size > 500) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    return false;
  }
  rec.n += 1;
  return rec.n > max;
}
function crossSite(req) {
  const origin = req.headers.origin;
  if (!origin) return false;                       // same-origin GETs, curl, health checks
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/* ----------------------------------------------------------------- route */
export default async function handler(req, res) {
  const providerName = process.env.LLM_PROVIDER || 'gemini';

  if (crossSite(req)) return res.status(403).json({ error: 'Cross-site requests are not allowed' });

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('probe')) return probe(res, providerName);
    return health(res, providerName);
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const mode = body.mode;
  const textCap = mode === 'briefing' ? MAX_BRIEFING : mode === 'chat' ? MAX_CHAT_CONTEXT : MAX_TEXT;
  const text = String(body.text || '').slice(0, textCap);
  const sentence = String(body.sentence || '').slice(0, MAX_SENTENCE);
  const lang = body.lang === 'ko' ? 'ko' : 'en';
  const history = String(body.history || '').slice(0, MAX_HISTORY);

  if (!PROMPTS[mode]) return res.status(400).json({ error: 'Unknown mode: ' + mode });
  if (!text.trim()) return res.status(400).json({ error: 'Empty selection' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: '잠시 후 다시 시도하세요 (요청이 너무 잦습니다)' });

  const provider = providers[providerName];
  if (!provider) return res.status(500).json({ error: 'Unknown provider: ' + providerName });

  try {
    const raw = await provider({ system: SYSTEM, prompt: PROMPTS[mode](text, sentence, lang, history) });
    // Answers for one selection never change, so let the CDN keep them for a day.
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json(parseJSON(raw));
  } catch (e) {
    return res.status(502).json({ error: e.message || 'Lookup failed' });
  }
}
