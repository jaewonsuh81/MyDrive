/**
 * MyDrive — daily reading feed from Notion
 *
 * Returns today's two pages whole: the Daily Briefing and the Digest. They are
 * meant to be read here, not summarised again, so the full text comes across
 * and the browser decides whether to keep each one.
 *
 * Also pulls out two things the reader can act on without spending a lookup:
 *   links  — every headline the page links to, for essay source material
 *   vocab  — the words the page already defines
 *
 * Environment variables:
 *   NOTION_TOKEN            required
 *   NOTION_QUERY_BRIEFING   optional, default "Daily Briefing"
 *   NOTION_QUERY_DIGEST     optional, default "Digest"
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
    if (r.status === 404)
      throw new Error('The integration cannot see that page. Open the database in Notion and add the connection.');
    throw new Error(`Notion ${r.status}: ${body.slice(0, 160)}`);
  }
  return r.json();
}

const plain = (rt) => (rt || []).map((t) => t.plain_text || '').join('');

async function allBlocks(id, token) {
  let out = [], cursor;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const j = await notion(`/blocks/${id}/children${q}`, token);
    out = out.concat(j.results || []);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor && out.length < 400);
  return out;
}

/* Notion attaches a link to the text run that carries it, so headlines and
   their sources have to be gathered run by run, not block by block. */
function harvest(blocks) {
  const lines = [];
  const links = [];
  const items = [];
  const seen = new Set();
  let counter = 0;      // Notion does not send the number of a numbered item
  let section = '';

  for (const b of blocks) {
    const t = b.type;
    const rt = b[t]?.rich_text;

    if (t === 'bookmark' || t === 'embed') {
      const url = b[t]?.url;
      if (url && !seen.has(url)) { seen.add(url); links.push({ title: url, url, section }); }
      continue;
    }
    if (t === 'divider') { lines.push('---'); counter = 0; continue; }
    if (!rt) continue;

    // A link lives on the run that carries it, so headlines and their sources
    // have to be read run by run rather than block by block.
    let blockUrl = null;
    for (const run of rt) {
      const url = run.href || run.text?.link?.url;
      const label = (run.plain_text || '').trim();
      if (!url) continue;
      if (!blockUrl) blockUrl = url;
      if (label && !seen.has(url)) { seen.add(url); links.push({ title: label, url, section }); }
    }

    const text = plain(rt).replace(/\\/g, '').trim();
    if (!text) continue;

    if (t === 'heading_1' || t === 'heading_2' || t === 'heading_3') {
      section = text; counter = 0;
      lines.push((t === 'heading_1' ? '\n# ' : t === 'heading_2' ? '\n## ' : '\n### ') + text);
      continue;
    }
    if (t === 'numbered_list_item') {
      // Restore the number so downstream parsing and reading both work.
      counter += 1;
      lines.push(counter + '. ' + text);
      continue;
    }
    if (t === 'bulleted_list_item') {
      lines.push('\u2022 ' + text);
      // Headline bullets are the reference material worth surfacing.
      // The score line under each headline is metadata, not a reference.
      if (text.length > 25 && !/^score\b/i.test(text))
        items.push({ title: text, url: blockUrl || null, section });
      continue;
    }
    if (t === 'quote') { lines.push('> ' + text); continue; }
    lines.push(text);
  }
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), links, items };
}

/* Two shapes appear in practice:
     1. **Word**: definition
     2. word* — definition (Section)
   Both are worth catching; a word missed here costs a paid lookup later. */
function vocabFrom(text) {
  const out = [];
  const seen = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\*/g, '').trim();
    if (!line) continue;
    let m = line.match(/^\d+\.\s*([A-Za-z][A-Za-z '-]{1,30}?)\s*[:：]\s*(.+)$/);
    if (!m) m = line.match(/^\d+\.\s*([A-Za-z][A-Za-z '-]{1,30}?)\s*[—–]\s*(.+)$/);
    if (!m) continue;
    const word = m[1].trim();
    if (seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    out.push({
      word,
      meaning: m[2].replace(/\s*\(([^)]*)\)\s*$/, '').trim(),
      section: (line.match(/\(([^)]*)\)\s*$/) || [])[1] || '',
    });
  }
  return out;
}

const titleOf = (p) => {
  const props = p.properties || {};
  for (const k of Object.keys(props)) if (props[k].type === 'title') return plain(props[k].title);
  return '';
};

async function latest(token, query, match) {
  const found = await notion('/search', token, {
    method: 'POST',
    body: JSON.stringify({
      query,
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 15,
    }),
  });
  const pages = (found.results || [])
    .map((p) => ({ id: p.id, url: p.url, title: titleOf(p), edited: p.last_edited_time }))
    .filter((p) => match.test(p.title))
    .sort((a, b) => String(b.title).localeCompare(String(a.title)));
  return pages[0] || null;
}

async function build(token, key, label, query, match) {
  const page = await latest(token, query, match);
  if (!page) return { key, label, missing: true, query };
  const { text, links, items } = harvest(await allBlocks(page.id, token));
  return {
    key, label,
    title: page.title,
    url: page.url,
    date: (page.title.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || page.edited?.slice(0, 10) || '',
    text,
    chars: text.length,
    links,
    items,
    vocab: vocabFrom(text),
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
  if (!token)
    return res.status(200).json({
      configured: false,
      hint: 'Add NOTION_TOKEN in Vercel, Settings, Environment Variables, then Redeploy.',
    });

  try {
    const docs = await Promise.all([
      build(token, 'briefing', 'Daily Briefing',
        process.env.NOTION_QUERY_BRIEFING || 'Daily Briefing', /daily briefing/i),
      build(token, 'digest', 'Digest',
        process.env.NOTION_QUERY_DIGEST || 'Digest', /^digest/i),
    ]);

    // One links list across both pages, duplicates removed.
    const links = [];
    const seen = new Set();
    for (const d of docs)
      for (const l of d.links || [])
        if (!seen.has(l.url)) { seen.add(l.url); links.push({ ...l, from: d.label }); }

    // Headline bullets, whether or not the page linked them. These are what a
    // day's essay actually cites, so they travel even without a URL.
    const items = [];
    const seenItem = new Set();
    for (const d of docs)
      for (const it of d.items || []) {
        const k = it.title.slice(0, 60);
        if (seenItem.has(k)) continue;
        seenItem.add(k);
        items.push({ ...it, from: d.label });
      }

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate');
    return res.status(200).json({
      configured: true,
      date: docs.find((d) => d.date)?.date || '',
      docs: docs.filter((d) => !d.missing),
      items,
      missing: docs.filter((d) => d.missing).map((d) => d.query),
      links,
    });
  } catch (e) {
    return res.status(502).json({ configured: true, error: e.message });
  }
}
