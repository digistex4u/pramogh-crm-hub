// Vercel Serverless Function — receives real-time contact pushes from Freshsales workflows
// Freshsales POSTs contact data here whenever a contact is created/updated
//
// Callback URL to use in Freshsales:
//   https://pramogh-crm-hub.vercel.app/api/freshsales-webhook?key=YOUR_ADMIN_PASSWORD

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Auth check
  const key = req.query.key;
  if (!key || key !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid key' });
  }

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
  }

  const repo = process.env.GITHUB_REPO || 'digistex4u/pramogh-crm-hub';

  try {
    const data = req.body || {};
    const phone = cleanPhone(
      data.mobile_number || data.Mobile || data.phone || data.Phone ||
      data.mobile || data['Mobile Number'] || data['Phone Number'] || ''
    );
    if (!phone) {
      return res.status(400).json({ error: 'No valid phone number in payload', received: Object.keys(data) });
    }
    const contact = { phone };
    const name = cleanName(
      data.display_name || data['Display Name'] ||
      data.name || data.Name ||
      [data.first_name || data['First Name'] || '', data.last_name || data['Last Name'] || ''].filter(Boolean).join(' ') || ''
    );
    if (name) contact.name = name;
    else contact.name = 'Unknown';
    const email = data.email || data.Email || data['Email Address'] || '';
    if (email) contact.email = email.toLowerCase();
    const city = data.city || data.City || '';
    const state = data.state || data.State || '';
    if (city) contact.city = city;
    if (state) contact.state = state;
    const owner = data.sales_owner || data['Sales Owner'] || data.owner || data.Owner || '';
    if (owner) contact.sales_owner = owner;
    const source = data.lead_source || data['Lead Source'] || data.source || data.Source || '';
    if (source) contact.source = source;
    const stage = data.lifecycle_stage || data['Lifecycle Stage'] || data.stage || data.Stage ||
                  data.lead_stage || data['Lead Stage'] || '';
    if (stage) contact.stage = stage;
    const gemstone = data.cf_gemstone || data.Gemstone || data['Gemstone Interest'] ||
                     data.cf_gemstone_interest || data.cf_product || data.Product || '';
    if (gemstone) contact.gemstone = gemstone;
    const lostReason = data.cf_lost_reason || data['Lost Reason'] || data.cf_reason_lost || '';
    if (lostReason) contact.lost_reason = lostReason;
    const tags = data.cf_tags || data.Tags || data.tags || '';
    if (tags) contact.tags = tags;
    const dealValue = data.cf_deal_value || data['Deal Value'] || data.cf_amount || '';
    if (dealValue) contact.deal_value = parseFloat(dealValue) || 0;
    contact.updated_at = new Date().toISOString();
    if (data.id || data.Id) contact.fs_id = data.id || data.Id;
    const result = await mergeAndPush(contact, repo, githubToken);
    return res.status(200).json({
      success: true, phone: contact.phone, name: contact.name,
      action: result.action, total: result.total, commit: result.sha,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function mergeAndPush(contact, repo, token, retries = 3) {
  const filePath = 'public/contacts.js';
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'pramogh-crm-webhook',
  };
  for (let attempt = 0; attempt < retries; attempt++) {
    let existingContacts = [];
    let sha = null;
    const getResp = await fetch(apiUrl, { headers });
    if (getResp.ok) {
      const fileData = await getResp.json();
      sha = fileData.sha;
      const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
      const match = content.match(/window\.PRAMOGH_CONTACTS\s*=\s*(\[[\s\S]*\])\s*;?/);
      if (match) {
        try { existingContacts = JSON.parse(match[1]); } catch (e) { /* start fresh */ }
      }
    }
    const contactMap = new Map();
    for (const c of existingContacts) {
      if (c.phone) contactMap.set(c.phone, c);
    }
    let action = 'new';
    if (contactMap.has(contact.phone)) {
      const existing = contactMap.get(contact.phone);
      const merged = { ...existing };
      for (const [key, val] of Object.entries(contact)) {
        if (val !== undefined && val !== '' && val !== null) merged[key] = val;
      }
      contactMap.set(contact.phone, merged);
      action = 'updated';
    } else {
      contactMap.set(contact.phone, contact);
    }
    const finalContacts = Array.from(contactMap.values());
    const jsContent = [
      '// Pramogh CRM Contacts Database',
      `// Webhook update: ${new Date().toISOString()}`,
      `// ${finalContacts.length.toLocaleString()} unique contacts`,
      `window.PRAMOGH_CONTACTS = ${JSON.stringify(finalContacts)};`,
      ''
    ].join('\n');
    const putBody = {
      message: `Webhook: ${action} ${contact.phone} (${contact.name})`,
      content: Buffer.from(jsContent).toString('base64'),
      branch: 'main',
    };
    if (sha) putBody.sha = sha;
    const putResp = await fetch(apiUrl, {
      method: 'PUT', headers, body: JSON.stringify(putBody),
    });
    if (putResp.ok) {
      const result = await putResp.json();
      return { action, total: finalContacts.length, sha: result.content?.sha?.slice(0, 7) };
    }
    if (putResp.status === 409 && attempt < retries - 1) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    const err = await putResp.text();
    throw new Error(`GitHub push failed: ${putResp.status} ${err.slice(0, 200)}`);
  }
}

function cleanPhone(raw) {
  if (!raw) return '';
  let p = String(raw).replace(/[^0-9+]/g, '');
  if (p.startsWith('+91') && p.length === 13) p = p.slice(3);
  else if (p.startsWith('91') && p.length === 12) p = p.slice(2);
  if (p.length === 10 && /^[6-9]/.test(p)) return p;
  if (p.length > 10) return p;
  return p.length >= 7 ? p : '';
}

function cleanName(raw) {
  if (!raw) return '';
  return String(raw).replace(/[`'"]/g, '').replace(/\s+/g, ' ').trim()
    .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
