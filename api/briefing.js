/**
 * MyDrive — daily briefing endpoint
 *
 * Reads the most recent "Daily Briefing — YYYY-MM-DD" page from Notion and
 * returns it in pieces the reader can act on: a summary, one entry per
 * section, and the vocabulary list the briefing already defines.
 *
 * Nothing is stored here. The browser decides which pieces are worth keeping,
 * which is the point — the raw feed is large and most of it is read once.
 *
 * Environment variables:
 *   NOTION_TOKEN    required. Internal integration secret (starts with ntn_ or secret_)
 *   NOTION_QUERY    optional. Page title to search for. Default "Daily Briefing"
 */

const NOTION_VERSION = '2022-06-28';

async function notion(path, token, init = {}) {
  const r = await fetch('https://api.notion.com/v1' + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    const body = await r.text();
    if (r.status === 401) throw new Error('NOTION_TOKEN is not valid');
    if (r.status === 404) throw new Error('The integration cannot see that page. Share the database with it in Notion.');
    throw new Error(`Notion ${r.status}: ${body.slice(0, 160)}`);
  }
  return r.json();
}

/* Notion returns rich text as an array of runs; we only need the words. */
const plain = (rt) => (rt || []).map((t) => t.plain_text || '').join('').trim();

async function allBlocks(id, token) {
  let out = [], cursor;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const j = await notion(`/blocks/${id}/children${q}`, token);
    out = out.concat(j.results || []);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor && out.length < 300);
  return out;
}

/* The briefing is a flat page: an opening paragraph, then H2 sections, and a
   numbered "Vocabulary Notes" list at the end. Split on those boundaries. */
function parse(blocks) {
  const sections = [];
  const vocab = [];
  let summary = '';
  let current = null;
  let inVocab = false;

  for (const b of blocks) {
    const t = b.type;
    const text = plain(b[t]?.rich_text);
    if (t === 'heading_1' || t === 'heading_2' || t === 'heading_3') {
      inVocab = /vocabulary/i.test(text);
      current = inVocab ? null : { title: text, paras: [] };
      if (current) sections.push(current);
      continue;
    }
    if (!text) continue;
    if (inVocab || t === 'numbered_list_item' || t === 'bulleted_list_item') {
      // "1. throughline* — a single connecting theme ... (Opening)"
      const m = text.match(/^\s*\d*\.?\s*([^—–-]{1,40}?)\s*[*]?\s*[—–-]\s*(.+)$/);
      if (inVocab && m) {
        vocab.push({
          word: m[1].replace(/[*]/g, '').trim(),
          meaning: m[2].replace(/\s*\(([^)]*)\)\s*$/, '').trim(),
          section: (text.match(/\(([^)]*)\)\s*$/) || [])[1] || '',
        });
        continue;
      }
    }
    if (current) current.paras.push(text);
    else if (!summary) summary = text;
  }

  return {
    summary,
    vocab,
    sections: sections
      .map((s, i) => ({
        id: 's' + i,
        title: s.title,
        text: s.paras.join('\n\n'),
        chars: s.paras.join('\n\n').length,
      }))
      .filter((s) => s.chars > 80),
  };
}

function crossSite(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}

export default async function handler(req, res) {
  if (crossSite(req)) return res.status(403).json({ error: 'Cross-site requests are not allowed' });

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return res.status(200).json({
      configured: false,
      hint: 'Add NOTION_TOKEN in Vercel → Settings → Environment Variables, then Redeploy.',
    });
  }

  try {
    const query = process.env.NOTION_QUERY || 'Daily Briefing';
    const found = await notion('/search', token, {
      method: 'POST',
      body: JSON.stringify({
        query,
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 10,
      }),
    });

    // Titles look like "Daily Briefing — 2026-09-14"; prefer the newest dated one.
    const titleOf = (p) => {
      const props = p.properties || {};
      for (const k of Object.keys(props))
        if (props[k].type === 'title') return plain(props[k].title);
      return '';
    };
    const pages = (found.results || [])
      .map((p) => ({ id: p.id, url: p.url, title: titleOf(p), edited: p.last_edited_time }))
      .filter((p) => /daily briefing/i.test(p.title))
      .sort((a, b) => String(b.title).localeCompare(String(a.title)));

    if (!pages.length)
      return res.status(200).json({ configured: true, empty: true,
        hint: 'No page matching "' + query + '" is shared with the integration.' });

    const page = pages[0];
    const parsed = parse(await allBlocks(page.id, token));
    const date = (page.title.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || page.edited?.slice(0, 10) || '';

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({ configured: true, date, title: page.title, url: page.url, ...parsed });
  } catch (e) {
    return res.status(502).json({ configured: true, error: e.message });
  }
}
