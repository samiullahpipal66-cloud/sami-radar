// api/match-opportunities.js
// Scores opportunities that don't have a match yet, using Gemini.

const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_PER_RUN = 15; // stays under the ~20/day free quota with headroom
const DELAY_MS = 2000; // small courtesy delay between requests

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !GEMINI_API_KEY) {
    return res.status(500).json({
      error: "Missing SUPABASE_URL, SUPABASE_SERVICE_KEY, or GEMINI_API_KEY environment variables in Vercel.",
    });
  }

  const sbHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
  };

  // 1. Get the profile
  const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profile?select=*&limit=1`, { headers: sbHeaders });
  const profileRows = await profileRes.json();
  const profile = profileRows?.[0];
  if (!profile) {
    return res.status(400).json({ error: "No profile found in the profile table." });
  }

  // 2. Get opportunities that don't have a match row yet
  const oppRes = await fetch(
    `${SUPABASE_URL}/rest/v1/opportunities?select=id,title,category,source,description,funding_type,country&matches=is.null`,
    { headers: { ...sbHeaders, "Accept-Profile": "public" } }
  );
  let opportunities = [];
  if (oppRes.ok) {
    opportunities = await oppRes.json();
  } else {
    // Fallback: fetch all, then filter out ones that already have a match (in case the embedded filter isn't supported)
    const allRes = await fetch(`${SUPABASE_URL}/rest/v1/opportunities?select=id,title,category,source,description,funding_type,country`, { headers: sbHeaders });
    const all = await allRes.json();
    const matchedRes = await fetch(`${SUPABASE_URL}/rest/v1/matches?select=opportunity_id`, { headers: sbHeaders });
    const matched = await matchedRes.json();
    const matchedIds = new Set(matched.map((m) => m.opportunity_id));
    opportunities = all.filter((o) => !matchedIds.has(o.id));
  }

  opportunities = opportunities.slice(0, MAX_PER_RUN);

  const results = [];

  for (const opp of opportunities) {
    if (results.length > 0) await sleep(DELAY_MS);
    const prompt = `You are helping a nursing student evaluate whether an opportunity fits them.

STUDENT PROFILE:
- Degree: ${profile.degree}, ${profile.university}
- CGPA: ${profile.cgpa}
- Country: ${profile.country}
- Field: ${profile.field_of_study}
- Research interests: ${profile.research_interests}
- Skills: ${profile.skills}
- Certifications: ${profile.certifications}
- Research experience: ${profile.research_experience}
- Publications: ${profile.publications}
- English proficiency: ${profile.english_proficiency}
- Preferred countries: ${profile.preferred_countries}
- Funding preference: ${profile.funding_preference}
- Target degree level: ${profile.degree_level_preference}
- Career goal: ${profile.career_goals}
- Categories of interest: ${profile.categories_of_interest}
- Recent achievements (updated over time): ${profile.recent_achievements || "None yet"}

OPPORTUNITY:
- Title: ${opp.title}
- Category: ${opp.category}
- Source: ${opp.source}
- Funding: ${opp.funding_type}
- Country: ${opp.country}
- Description: ${opp.description}

Respond with ONLY valid JSON (no markdown fences, no extra text), in exactly this shape:
{"match_percent": <0-100 integer>, "status": "<Apply|Consider|Skip|Not Eligible>", "reasoning": "<1-2 sentences>", "missing_requirements": "<1 short sentence, or 'None'>"}`;

    try {
      let geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
          }),
        }
      );

      // Retry once if the model is temporarily busy (503)
      if (geminiRes.status === 503) {
        await sleep(5000);
        geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": GEMINI_API_KEY,
            },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
            }),
          }
        );
      }

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        results.push({ opportunity: opp.title, status: `gemini error: ${errText.slice(0, 200)}` });
        continue;
      }

      const geminiData = await geminiRes.json();
      let text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      text = text.trim().replace(/^```json\s*/i, "").replace(/```$/, "").trim();

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        results.push({ opportunity: opp.title, status: "could not parse Gemini response" });
        continue;
      }

      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/matches`, {
        method: "POST",
        headers: { ...sbHeaders, Prefer: "return=minimal" },
        body: JSON.stringify([
          {
            opportunity_id: opp.id,
            match_percent: parsed.match_percent,
            status: parsed.status,
            reasoning: parsed.reasoning,
            missing_requirements: parsed.missing_requirements,
          },
        ]),
      });

      if (!insertRes.ok) {
        const errText = await insertRes.text();
        results.push({ opportunity: opp.title, status: `insert failed: ${errText.slice(0, 200)}` });
        continue;
      }

      results.push({ opportunity: opp.title, match_percent: parsed.match_percent, status: parsed.status });
    } catch (err) {
      results.push({ opportunity: opp.title, status: `error: ${err.message}` });
    }
  }

  return res.status(200).json({ ranAt: new Date().toISOString(), scored: results.length, results });
}
