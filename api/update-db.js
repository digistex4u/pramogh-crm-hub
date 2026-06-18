// Vercel Serverless Function — pushes updated contacts.js to GitHub
// Env vars needed: ADMIN_PASSWORD, GITHUB_TOKEN, GITHUB_REPO (optional, defaults to digistex4u/pramogh-crm-hub)

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { adminPassword, contacts, contactCount } = req.body || {};

  // Verify admin password
  const expectedPassword = process.env.ADMIN_PASSWORD;
  if (!expectedPassword) {
    return res.status(500).json({
      error: 'ADMIN_PASSWORD not configured',
      detail: 'Add ADMIN_PASSWORD to Vercel Environment Variables (Settings → Environment Variables)'
    });
  }
  if (adminPassword !== expectedPassword) {
    return res.status(403).json({ error: 'Invalid admin password' });
  }

  // Validate data
  if (!contacts || typeof contacts !== 'string') {
    return res.status(400).json({ error: 'Missing contacts data' });
  }

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    return res.status(500).json({
      error: 'GITHUB_TOKEN not configured',
      detail: 'Create a GitHub Fine-Grained Personal Access Token with repo write access, then add it to Vercel Environment Variables'
    });
  }

  const repo = process.env.GITHUB_REPO || 'digistex4u/pramogh-crm-hub';
  const filePath = 'public/contacts.js';
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;

  try {
    // Step 1: Check if file exists (get current SHA if it does)
    let existingSha = null;
    const getResp = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'pramogh-crm-hub'
      }
    });

    if (getResp.ok) {
      const existing = await getResp.json();
      existingSha = existing.sha;
    } else if (getResp.status !== 404) {
      const err = await getResp.text();
      return res.status(500).json({
        error: 'GitHub API error checking file',
        detail: `${getResp.status}: ${err}`
      });
    }

    // Step 2: Create or update file
    const body = {
      message: `Update CRM contacts — ${(contactCount || 0).toLocaleString()} contacts [auto-push from admin]`,
      content: Buffer.from(contacts).toString('base64'),
      branch: 'main',
    };
    if (existingSha) body.sha = existingSha;

    const putResp = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'pramogh-crm-hub'
      },
      body: JSON.stringify(body)
    });

    if (putResp.ok) {
      const result = await putResp.json();
      return res.status(200).json({
        success: true,
        sha: result.content?.sha,
        message: `Pushed ${(contactCount || 0).toLocaleString()} contacts to ${repo}`,
        url: result.content?.html_url
      });
    } else {
      const err = await putResp.text();
      return res.status(500).json({
        error: 'GitHub push failed',
        detail: `${putResp.status}: ${err}`
      });
    }

  } catch (err) {
    return res.status(500).json({
      error: 'Server error',
      detail: err.message
    });
  }
}
