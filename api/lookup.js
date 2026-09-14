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

const MAX_TEXT = 4000;      // cost guard
const MAX_SENTENCE = 1200;

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

  explain: (text, sentence) => `TASK: simple explanation
SELECTED: ${JSON.stringify(text)}
SENTENCE: ${JSON.stringify(sentence)}

Return JSON: {"explanation":str,"analogy":str}
explanation = 배경지식이 없어도 이해할 수 있게 2~3문장, 한국어
analogy     = 짧은 비유 하나, 없으면 ""`,

  deep: (text, sentence) => `TASK: in-depth explanation
SELECTED: ${JSON.stringify(text)}
SENTENCE: ${JSON.stringify(sentence)}

Return JSON: {"explanation":str,"analogy":str}
explanation = 왜 그런지, 어떤 원리가 작동하는지까지 3~5문장, 한국어
analogy     = 짧은 비유 하나, 없으면 ""`,
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

    let lastError;
    for (const model of candidates) {
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
              maxOutputTokens: 4096,
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
    throw lastError || new Error('No usable Gemini model');
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

/* ----------------------------------------------------------------- route */
export default async function handler(req, res) {
  const providerName = process.env.LLM_PROVIDER || 'gemini';

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
  const text = String(body.text || '').slice(0, MAX_TEXT);
  const sentence = String(body.sentence || '').slice(0, MAX_SENTENCE);
  const lang = body.lang === 'ko' ? 'ko' : 'en';

  if (!PROMPTS[mode]) return res.status(400).json({ error: 'Unknown mode: ' + mode });
  if (!text.trim()) return res.status(400).json({ error: 'Empty selection' });

  const provider = providers[providerName];
  if (!provider) return res.status(500).json({ error: 'Unknown provider: ' + providerName });

  try {
    const raw = await provider({ system: SYSTEM, prompt: PROMPTS[mode](text, sentence, lang) });
    // Answers for one selection never change, so let the CDN keep them for a day.
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json(parseJSON(raw));
  } catch (e) {
    return res.status(502).json({ error: e.message || 'Lookup failed' });
  }
}
