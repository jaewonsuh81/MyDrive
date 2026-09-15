/**
 * MyDrive — public client configuration
 *
 * Hands the browser the two values it needs to talk to Supabase. Both are
 * public by design: the anon key identifies the project, it does not grant
 * access. Row Level Security is what protects the data, which is why the
 * schema enables it on every table.
 *
 * Nothing secret is ever returned from here. GEMINI_API_KEY, NOTION_TOKEN and
 * the Supabase service role key stay on the server and are not referenced.
 *
 * Environment variables:
 *   SUPABASE_URL       optional. https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY  optional. The anon / publishable key
 */

function crossSite(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}

export default function handler(req, res) {
  if (crossSite(req)) return res.status(403).json({ error: 'Cross-site requests are not allowed' });

  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anon = process.env.SUPABASE_ANON_KEY || '';

  // A misconfigured key is a common paste error; fail clearly rather than
  // letting the browser send doomed requests all session.
  const looksWrong = anon && anon.startsWith('sb_secret');

  res.setHeader('Cache-Control', 'public, s-maxage=300');
  return res.status(200).json({
    supabase: Boolean(url && anon && !looksWrong),
    supabaseUrl: url || null,
    supabaseAnonKey: looksWrong ? null : anon || null,
    notion: Boolean(process.env.NOTION_TOKEN),
    warning: looksWrong
      ? 'SUPABASE_ANON_KEY looks like a secret key. Use the anon / publishable key instead.'
      : undefined,
  });
}
