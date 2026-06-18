export const config = { runtime: 'edge' };

// Reads WATI_CHANNELS env var (JSON object)
// Format: {"ch1":{"name":"Pramogh Main","url":"https://...","token":"Bearer xxx"}, "ch2":{...}}
// Returns only names and IDs to the frontend — NEVER tokens

function getChannels() {
  try {
    const raw = process.env.WATI_CHANNELS;
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

export default async function handler(request) {
  const channels = getChannels();

  // Return only safe fields (name + id), strip tokens and URLs
  const safe = {};
  for (const [id, ch] of Object.entries(channels)) {
    safe[id] = { name: ch.name, id };
  }

  return new Response(JSON.stringify({ channels: safe }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
