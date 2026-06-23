// Vercel Serverless Function — CRUD for WhatsApp automation rules
// Stores automations in public/automations.js via GitHub API (same pattern as contacts.js)
// Protected by session cookie (middleware) — no separate admin password needed for reads
// Writes require ADMIN_PASSWORD in body

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
  const repo = process.env.GITHUB_REPO || 'digistex4u/pramogh-crm-hub';
  const filePath = 'public/automations.js';
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const ghHeaders = {
    'Authorization': `Bearer ${githubToken}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'pramogh-crm-automations',
  };

  // ── GET: Return current automations ──
  if (req.method === 'GET') {
    try {
      const automations = await readAutomations(apiUrl, ghHeaders);
      // Also return available channels (names only, no tokens)
      const channels = getChannelNames();
      return res.status(200).json({ automations, channels });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: Create / Update / Delete / Toggle automation ──
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

  const { adminPassword, action, automation, automationId } = req.body || {};

  // Require admin password for all write operations
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || adminPassword !== expected) {
    return res.status(403).json({ error: 'Invalid admin password' });
  }

  try {
    const { automations, sha } = await readAutomationsWithSha(apiUrl, ghHeaders);

    let updated = [...automations];
    let resultAction = '';

    switch (action) {
      case 'create': {
        if (!automation || !automation.name) {
          return res.status(400).json({ error: 'Automation name required' });
        }
        const newAuto = {
          id: 'auto_' + Date.now(),
          name: automation.name,
          enabled: automation.enabled !== false,
          trigger_on: automation.trigger_on || 'both',
          conditions: automation.conditions || [],
          action: automation.action || {},
          cooldown_hours: automation.cooldown_hours || 0,
          created_at: new Date().toISOString(),
          last_modified: new Date().toISOString(),
        };
        updated.push(newAuto);
        resultAction = 'created';
        break;
      }

      case 'update': {
        if (!automationId) return res.status(400).json({ error: 'automationId required' });
        const idx = updated.findIndex(a => a.id === automationId);
        if (idx < 0) return res.status(404).json({ error: 'Automation not found' });
        updated[idx] = {
          ...updated[idx],
          ...automation,
          id: automationId, // prevent ID change
          last_modified: new Date().toISOString(),
        };
        resultAction = 'updated';
        break;
      }

      case 'delete': {
        if (!automationId) return res.status(400).json({ error: 'automationId required' });
        const before = updated.length;
        updated = updated.filter(a => a.id !== automationId);
        if (updated.length === before) return res.status(404).json({ error: 'Automation not found' });
        resultAction = 'deleted';
        break;
      }

      case 'toggle': {
        if (!automationId) return res.status(400).json({ error: 'automationId required' });
        const idx = updated.findIndex(a => a.id === automationId);
        if (idx < 0) return res.status(404).json({ error: 'Automation not found' });
        updated[idx].enabled = !updated[idx].enabled;
        updated[idx].last_modified = new Date().toISOString();
        resultAction = updated[idx].enabled ? 'enabled' : 'disabled';
        break;
      }

      default:
        return res.status(400).json({ error: 'Invalid action. Use: create, update, delete, toggle' });
    }

    // Push to GitHub
    const pushResult = await pushAutomations(updated, sha, resultAction, apiUrl, ghHeaders, repo);
    return res.status(200).json({
      success: true,
      action: resultAction,
      total: updated.length,
      automations: updated,
      commit: pushResult.sha,
    });

  } catch (err) {
    console.error('Automations error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── Helpers ──

function getChannelNames() {
  try {
    const channels = JSON.parse(process.env.WATI_CHANNELS || '{}');
    const safe = {};
    for (const [id, ch] of Object.entries(channels)) {
      safe[id] = { name: ch.name, id };
    }
    return safe;
  } catch (e) {
    return {};
  }
}

async function readAutomations(apiUrl, headers) {
  const resp = await fetch(apiUrl, { headers });
  if (!resp.ok) {
    if (resp.status === 404) return [];
    throw new Error('GitHub read failed: ' + resp.status);
  }
  const data = await resp.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  const match = content.match(/window\.PRAMOGH_AUTOMATIONS\s*=\s*(\[[\s\S]*\])\s*;?/);
  if (match) {
    try { return JSON.parse(match[1]); } catch (e) {}
  }
  return [];
}

async function readAutomationsWithSha(apiUrl, headers) {
  const resp = await fetch(apiUrl, { headers });
  if (!resp.ok) {
    if (resp.status === 404) return { automations: [], sha: null };
    throw new Error('GitHub read failed: ' + resp.status);
  }
  const data = await resp.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  const match = content.match(/window\.PRAMOGH_AUTOMATIONS\s*=\s*(\[[\s\S]*\])\s*;?/);
  let automations = [];
  if (match) {
    try { automations = JSON.parse(match[1]); } catch (e) {}
  }
  return { automations, sha: data.sha };
}

async function pushAutomations(automations, sha, action, apiUrl, headers, repo, retries = 2) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const jsContent = '// Pramogh CRM Automation Rules\n// Updated: ' + new Date().toISOString() + '\n// ' + automations.length + ' automations\nwindow.PRAMOGH_AUTOMATIONS = ' + JSON.stringify(automations, null, 2) + ';\n';

    const putBody = {
      message: 'Automation: ' + action + ' (' + automations.length + ' rules)',
      content: Buffer.from(jsContent).toString('base64'),
      branch: 'main',
    };
    if (sha) putBody.sha = sha;

    const resp = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(putBody) });
    if (resp.ok) {
      const result = await resp.json();
      return { sha: result.content?.sha?.slice(0, 7) };
    }

    if (resp.status === 409 && attempt < retries - 1) {
      // SHA conflict — re-read and retry
      const fresh = await fetch(apiUrl, { headers });
      if (fresh.ok) {
        const data = await fresh.json();
        sha = data.sha;
      }
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    const err = await resp.text();
    throw new Error('GitHub push failed: ' + resp.status + ' ' + err.slice(0, 200));
  }
}
