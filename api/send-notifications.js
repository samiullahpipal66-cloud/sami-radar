// api/send-notifications.js
// Sends one email covering: (1) new "Apply"-worthy matches not yet notified,
// (2) opportunities whose deadline is 30/7/3 days away and hasn't been reminded yet.

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !RESEND_API_KEY || !NOTIFY_EMAIL) {
    return res.status(500).json({ error: "Missing one of SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY, NOTIFY_EMAIL." });
  }

  const sbHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
  };

  // ---- 1. New high-match opportunities not yet notified ----
  const matchesRes = await fetch(
    `${SUPABASE_URL}/rest/v1/matches?select=id,match_percent,status,reasoning,notified,opportunities(title,source_url,deadline)&notified=eq.false&status=eq.Apply`,
    { headers: sbHeaders }
  );
  const newMatches = matchesRes.ok ? await matchesRes.json() : [];

  // ---- 2. Deadlines coming up (30 / 7 / 3 days) not already reminded ----
  const today = new Date();
  const windows = [30, 7, 3];
  const deadlineAlerts = [];

  for (const days of windows) {
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + days);
    const dateStr = targetDate.toISOString().slice(0, 10);

    const oppRes = await fetch(
      `${SUPABASE_URL}/rest/v1/opportunities?select=id,title,source_url,deadline&deadline=eq.${dateStr}`,
      { headers: sbHeaders }
    );
    if (!oppRes.ok) continue;
    const opps = await oppRes.json();

    for (const opp of opps) {
      const reminderType = `${days}_days`;
      const existingRes = await fetch(
        `${SUPABASE_URL}/rest/v1/reminders?select=id&opportunity_id=eq.${opp.id}&reminder_type=eq.${reminderType}`,
        { headers: sbHeaders }
      );
      const existing = existingRes.ok ? await existingRes.json() : [];
      if (existing.length === 0) {
        deadlineAlerts.push({ ...opp, days });
      }
    }
  }

  if (newMatches.length === 0 && deadlineAlerts.length === 0) {
    return res.status(200).json({ sent: false, reason: "Nothing new to notify." });
  }

  // ---- Build the email ----
  let html = `<h2>Opportunity Radar Update</h2>`;

  if (newMatches.length > 0) {
    html += `<h3>🔥 Worth applying to</h3><ul>`;
    for (const m of newMatches) {
      const opp = m.opportunities;
      html += `<li><strong>${opp?.title || "Untitled"}</strong> — ${m.match_percent}% match<br>${m.reasoning || ""}${
        opp?.source_url ? ` — <a href="${opp.source_url}">View</a>` : ""
      }</li>`;
    }
    html += `</ul>`;
  }

  if (deadlineAlerts.length > 0) {
    html += `<h3>⏰ Deadlines coming up</h3><ul>`;
    for (const d of deadlineAlerts) {
      html += `<li><strong>${d.title}</strong> — deadline in ${d.days} days (${d.deadline})${
        d.source_url ? ` — <a href="${d.source_url}">View</a>` : ""
      }</li>`;
    }
    html += `</ul>`;
  }

  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Opportunity Radar <onboarding@resend.dev>",
      to: [NOTIFY_EMAIL],
      subject: `Opportunity Radar: ${newMatches.length} new match(es), ${deadlineAlerts.length} deadline alert(s)`,
      html,
    }),
  });

  if (!emailRes.ok) {
    const errText = await emailRes.text();
    return res.status(500).json({ error: `Resend error: ${errText}` });
  }

  // ---- Mark things as notified so we don't repeat them ----
  for (const m of newMatches) {
    await fetch(`${SUPABASE_URL}/rest/v1/matches?id=eq.${m.id}`, {
      method: "PATCH",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ notified: true }),
    });
  }

  for (const d of deadlineAlerts) {
    await fetch(`${SUPABASE_URL}/rest/v1/reminders`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify([{ opportunity_id: d.id, reminder_type: `${d.days}_days` }]),
    });
  }

  return res.status(200).json({
    sent: true,
    newMatches: newMatches.length,
    deadlineAlerts: deadlineAlerts.length,
  });
}
