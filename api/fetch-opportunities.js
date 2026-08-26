// api/fetch-opportunities.js
// This runs on Vercel's server (not in the browser) whenever its URL is visited.
// It fetches opportunities from trusted RSS sources and saves new ones to Supabase.

const SOURCES = [
  {
    name: "EduCanada Scholarships",
    url: "https://www.educanada.ca/scholarships-bourses/rss/news-nouvelles_eng.xml",
    category: "Scholarships",
    funding_type: "Varies",
    country: "Canada",
  },
  {
    name: "WikiCFP - Nursing",
    url: "http://www.wikicfp.com/cfp/rss?cat=nursing",
    category: "Conferences",
    funding_type: "N/A",
    country: "International",
  },
  {
    name: "WikiCFP - Public Health",
    url: "http://www.wikicfp.com/cfp/rss?cat=public+health",
    category: "Conferences",
    funding_type: "N/A",
    country: "International",
  },
  {
    name: "Gilman Scholarship Blog",
    url: "https://www.gilmanscholarship.org/feed",
    category: "Scholarships",
    funding_type: "Fully funded",
    country: "USA",
  },
];

// Very small, dependency-free RSS/XML parser for standard <item> feeds.
function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.split(/<item[\s>]/i).slice(1);
  for (let block of itemBlocks) {
    block = block.split(/<\/item>/i)[0];
    const grab = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      if (!m) return "";
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]+>/g, "")
        .trim();
    };
    const title = grab("title");
    const link = grab("link") || grab("guid");
    const description = grab("description").slice(0, 500);
    const pubDate = grab("pubDate");
    if (title && link) {
      items.push({ title, link, description, pubDate });
    }
  }
  return items;
}

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables in Vercel." });
  }

  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
  };

  const summary = [];

  for (const source of SOURCES) {
    try {
      const feedRes = await fetch(source.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; OpportunityRadarBot/1.0)" },
      });
      if (!feedRes.ok) {
        summary.push({ source: source.name, status: `fetch failed (${feedRes.status})` });
        continue;
      }
      const xml = await feedRes.text();
      const items = parseRssItems(xml).slice(0, 15); // cap per source per run

      // Find which links we already have stored for this source, to avoid duplicates
      const existingRes = await fetch(
        `${SUPABASE_URL}/rest/v1/opportunities?select=source_url&source=eq.${encodeURIComponent(source.name)}`,
        { headers }
      );
      const existing = existingRes.ok ? await existingRes.json() : [];
      const existingUrls = new Set(existing.map((r) => r.source_url));

      const newRows = items
        .filter((item) => !existingUrls.has(item.link))
        .map((item) => ({
          title: item.title,
          category: source.category,
          source: source.name,
          source_url: item.link,
          description: item.description,
          funding_type: source.funding_type,
          country: source.country,
          raw_content: item.description,
        }));

      if (newRows.length > 0) {
        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/opportunities`, {
          method: "POST",
          headers: { ...headers, Prefer: "return=minimal" },
          body: JSON.stringify(newRows),
        });
        if (!insertRes.ok) {
          const errText = await insertRes.text();
          summary.push({ source: source.name, status: `insert failed: ${errText}` });
          continue;
        }
      }

      summary.push({ source: source.name, found: items.length, new: newRows.length });
    } catch (err) {
      summary.push({ source: source.name, status: `error: ${err.message}` });
    }
  }

  return res.status(200).json({ ranAt: new Date().toISOString(), summary });
}
