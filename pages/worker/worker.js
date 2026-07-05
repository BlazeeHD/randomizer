// ─────────────────────────────────────────────────────────────
// Bible verse of the day — Cloudflare Worker
//
// Why this version is different from before:
// - The LLM used to be asked to both PICK a verse and WRITE its
//   text from memory. Small models default to the same handful
//   of "greatest hits" verses regardless of date, which is why
//   it kept repeating. It was also regenerating NIV text from
//   memory, which is (a) copyrighted and (b) prone to subtly
//   wrong wording since it's a paraphrase, not real scripture.
// - Now: this Worker picks the reference itself from a curated
//   list (deterministic per day, or random when ?force=1 is
//   passed), fetches the real verse text from a free public-
//   domain Bible source, and only asks Groq for a short ORIGINAL
//   reflection on that specific verse — something an LLM is
//   actually good at and has no copyright concern doing.
// ─────────────────────────────────────────────────────────────

const VERSES = [
  'Joshua 1:9', 'Psalm 23:1', 'Psalm 46:10', 'Proverbs 3:5-6', 'Isaiah 41:10',
  'Isaiah 40:31', 'Jeremiah 29:11', 'Philippians 4:6-7', 'Philippians 4:13', 'Romans 8:28',
  'Matthew 6:34', 'Matthew 11:28', 'John 3:16', 'John 14:27', '1 Corinthians 13:4-7',
  '2 Corinthians 12:9', 'Galatians 5:22-23', 'Ephesians 2:8-9', 'Colossians 3:23', '1 Peter 5:7',
  'Psalm 34:18', 'Psalm 37:4', 'Psalm 91:1-2', 'Psalm 118:24', 'Psalm 121:1-2',
  'Psalm 139:14', 'Proverbs 16:9', 'Proverbs 17:22', 'Ecclesiastes 3:1', 'Isaiah 43:2',
  'Lamentations 3:22-23', 'Micah 6:8', 'Nahum 1:7', 'Habakkuk 3:19', 'Zephaniah 3:17',
  'Matthew 5:14-16', 'Matthew 6:33', 'Matthew 7:7', 'Mark 11:24', 'Luke 1:37',
  'John 8:12', 'John 15:5', 'John 16:33', 'Acts 1:8', 'Romans 5:8',
  'Romans 12:2', 'Romans 15:13', '1 Corinthians 10:13', '2 Corinthians 5:17', 'Galatians 6:9',
  'Ephesians 3:20', 'Ephesians 4:32', 'Philippians 1:6', 'Colossians 3:12', '1 Thessalonians 5:16-18',
  '2 Timothy 1:7', 'Hebrews 11:1', 'Hebrews 13:5', 'James 1:2-3', 'James 1:5',
];

function hashToIndex(str, mod) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h % mod;
}

async function fetchVerseText(reference) {
  const res = await fetch('https://bible-api.com/' + encodeURIComponent(reference) + '?translation=web');
  if (!res.ok) throw new Error('Bible source returned ' + res.status);
  const json = await res.json();
  if (!json.text) throw new Error('No verse text returned for ' + reference);
  return json.text.replace(/\s+/g, ' ').trim();
}

async function writeReflection(env, reference, verseText) {
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        temperature: 0.9,
        max_tokens: 100,
        messages: [
          {
            role: 'system',
            content:
              'You write short, warm, non-preachy devotional reflections. Respond with ONLY the reflection itself: 1-2 sentences, no preamble, no quotation marks, no markdown.',
          },
          {
            role: 'user',
            content: `Write a short original reflection (1-2 sentences) on how this Bible verse might apply to everyday life. Do not quote the verse back at length.\n\nReference: ${reference}\nText: "${verseText}"`,
          },
        ],
      }),
    });

    if (!groqRes.ok) return null;
    const groqData = await groqRes.json();
    const text = groqData.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    };

    try {
      const url = new URL(request.url);
      const today = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const force = url.searchParams.get('force') === '1';

      // Pick the reference ourselves — deterministic per day so the
      // page shows the same verse all day, or random when the user
      // explicitly asks for a different one.
      const idx = force
        ? Math.floor(Math.random() * VERSES.length)
        : hashToIndex(today, VERSES.length);
      const reference = VERSES[idx];

      const verseText = await fetchVerseText(reference);
      const reflection =
        (await writeReflection(env, reference, verseText)) ||
        'Take a moment today to sit with this verse and what it might be speaking into your life.';

      const payload = { date: today, reference, verse: verseText, reflection };

      const headers = { ...corsHeaders };
      // Only cache the deterministic, date-based response. A forced
      // refresh should never be served a cached copy.
      headers['Cache-Control'] = force ? 'no-store' : 'public, max-age=3600, s-maxage=86400';

      return new Response(JSON.stringify(payload), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
};