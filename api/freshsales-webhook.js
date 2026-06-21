// Vercel Serverless Function — receives real-time contact pushes from Freshsales workflows
// Also maintains webhook-log.js for dashboard visibility

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = req.query.key;
  if (!key || key !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid key' });
  }

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });

  const repo = process.env.GITHUB_REPO || 'digistex4u/pramogh-crm-hub';

  try {
    const raw = req.body || {};

    // Normalize all keys to lowercase for case-insensitive matching
    const data = {};
    for (const [k, v] of Object.entries(raw)) {
      data[k.toLowerCase().trim()] = v;
    }

    // Log received fields for debugging
    console.log('Webhook received fields:', Object.keys(raw).join(', '));
    console.log('Webhook values:', JSON.stringify(raw).slice(0, 500));

    // Find phone - try every possible field name
    const phone = cleanPhone(
      data['mobile'] || data['mobile number'] || data['mobile_number'] ||
      data['contact number'] || data['contact_number'] || data['phone'] ||
      data['phone number'] || data['phone_number'] || data['whatsapp'] ||
      data['work number'] || data['work_number'] ||
      findPhoneInValues(raw) || ''
    );

    if (!phone) {
      // Log the error to webhook-log.js (fire-and-forget)
      appendLog({
        ts: new Date().toISOString(),
        phone: '',
        name: '',
        action: 'error',
        status: 'fail',
        error: 'No valid phone number found',
        received_fields: Object.keys(raw).slice(0, 15),
        received_sample: JSON.stringify(raw).slice(0, 300),
      }, repo, githubToken).catch(e => console.error('Log write error:', e.message));

      return res.status(400).json({
        error: 'No valid phone number found',
        received_fields: Object.keys(raw),
        received_data: JSON.stringify(raw).slice(0, 1000)
      });
    }

    const contact = { phone };

    // Name
    const fname = data['first name'] || data['first_name'] || data['firstname'] || '';
    const lname = data['last name'] || data['last_name'] || data['lastname'] || '';
    const fullname = data['display name'] || data['display_name'] || data['name'] || data['full name'] || data['full_name'] || '';
    const name = cleanName(fullname || [fname, lname].filter(Boolean).join(' ') || 'Unknown');
    contact.name = name;

    // Email
    const email = data['email'] || data['email id'] || data['email_id'] || data['email address'] || data['email_address'] || '';
    if (email) contact.email = String(email).toLowerCase();

    // Location
    const city = data['city'] || data['address.city'] || '';
    const state = data['state'] || data['address.state'] || '';
    if (city) contact.city = city;
    if (state) contact.state = state;

    // Sales owner
    const owner = data['sales owner'] || data['sales_owner'] || data['owner'] || data['assigned to'] || '';
    if (owner) contact.sales_owner = typeof owner === 'object' ? (owner.display_name || owner.name || JSON.stringify(owner)) : owner;

    // Lead source
    const source = data['lead source'] || data['lead_source'] || data['source'] || '';
    if (source) contact.source = source;

    // Stage
    const stage = data['lifecycle stage'] || data['lifecycle_stage'] || data['stage'] || data['lead stage'] || data['lead_stage'] || data['status'] || '';
    if (stage) contact.stage = stage;

    // Custom fields
    for (const [k, v] of Object.entries(data)) {
      if (!v || v === '') continue;
      const lk = k.toLowerCase();
      if (lk.includes('gemstone') || lk.includes('gem type') || lk.includes('product interest'))
        contact.gemstone = v;
      if (lk.includes('lost reason') || lk.includes('lost_reason') || lk.includes('reason_lost'))
        contact.lost_reason = v;
      if (lk.includes('tag')) contact.tags = v;
      if (lk.includes('deal value') || lk.includes('deal_value') || lk.includes('amount'))
        contact.deal_value = parseFloat(v) || 0;
    }

    contact.updated_at = new Date().toISOString();
    const fsId = data['id'] || data['contact id'] || data['contact_id'] || '';
    if (fsId) contact.fs_id = fsId;

    const result = await mergeAndPush(contact, repo, githubToken);

    // Log success to webhook-log.js (fire-and-forget)
    appendLog({
      ts: new Date().toISOString(),
      phone: contact.phone,
      name: contact.name,
      email: contact.email || '',
      action: result.action,
      status: 'ok',
      total: result.total,
      fields_received: Object.keys(raw).slice(0, 15),
    }, repo, githubToken).catch(e => console.error('Log write error:', e.message));

    return res.status(200).json({
      success: true, phone: contact.phone, name: contact.name,
      action: result.action, total: result.total, commit: result.sha,
    });
  } catch (err) {
    console.error('Webhook error:', err.message);

    // Log crash to webhook-log.js (fire-and-forget)
    appendLog({
      ts: new Date().toISOString(),
      phone: '',
      name: '',
      action: 'crash',
      status: 'fail',
      error: err.message,
    }, repo, githubToken).catch(() => {});

    return res.status(500).json({ error: err.message });
  }
}

// Scan all values for anything that looks like an Indian phone number
function findPhoneInValues(obj) {
  for (const v of Object.values(obj)) {
    if (!v) continue;
    const cleaned = String(v).replace(/[^0-9+]/g, '');
    if (cleaned.length >= 10 && cleaned.length <= 13) {
      const phone = cleanPhone(cleaned);
      if (phone) return phone;
    }
  }
  return '';
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
        try { existingContacts = JSON.parse(match[1]); } catch (e) { }
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
      for (const [k, v] of Object.entries(contact)) {
        if (v !== undefined && v !== '' && v !== null) merged[k] = v;
      }
      contactMap.set(contact.phone, merged);
      action = 'updated';
    } else {
      contactMap.set(contact.phone, contact);
    }
    const finalContacts = Array.from(contactMap.values());
    const jsContent = '// Pramogh CRM Contacts Database\n// Webhook update: ' + new Date().toISOString() + '\n// ' + finalContacts.length + ' unique contacts\nwindow.PRAMOGH_CONTACTS = ' + JSON.stringify(finalContacts) + ';\n';
    const putBody = {
      message: 'Webhook: ' + action + ' ' + contact.phone + ' (' + contact.name + ')',
      content: Buffer.from(jsContent).toString('base64'),
      branch: 'main',
    };
    if (sha) putBody.sha = sha;
    const putResp = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(putBody) });
    if (putResp.ok) {
      const result = await putResp.json();
      return { action, total: finalContacts.length, sha: result.content?.sha?.slice(0, 7) };
    }
    if (putResp.status === 409 && attempt < retries - 1) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    const err = await putResp.text();
    throw new Error('GitHub push failed: ' + putResp.status + ' ' + err.slice(0, 200));
  }
}

// ── Webhook Activity Log ──
async function appendLog(entry, repo, token, retries = 2) {
  const filePath = 'public/webhook-log.js';
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'pramogh-crm-webhook-log',
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    let existingLog = [];
    let sha = null;

    const getResp = await fetch(apiUrl, { headers });
    if (getResp.ok) {
      const fileData = await getResp.json();
      sha = fileData.sha;
      const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
      const match = content.match(/window\.PRAMOGH_WEBHOOK_LOG\s*=\s*(\[[\s\S]*\])\s*;?/);
      if (match) {
        try { existingLog = JSON.parse(match[1]); } catch (e) {}
      }
    }

    // Prepend new entry (newest first), cap at 500
    existingLog.unshift(entry);
    if (existingLog.length > 500) existingLog = existingLog.slice(0, 500);

    const jsContent = '// Pramogh CRM Webhook Activity Log\n// Updated: ' + new Date().toISOString() + '\n// ' + existingLog.length + ' entries\nwindow.PRAMOGH_WEBHOOK_LOG = ' + JSON.stringify(existingLog) + ';\n';

    const putBody = {
      message: 'Log: ' + (entry.action || 'event') + ' ' + (entry.phone || entry.error || '').slice(0, 30),
      content: Buffer.from(jsContent).toString('base64'),
      branch: 'main',
    };
    if (sha) putBody.sha = sha;

    const putResp = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(putBody) });
    if (putResp.ok) return;

    if (putResp.status === 409 && attempt < retries - 1) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    // Non-critical — just log and move on
    console.error('Webhook log push failed:', putResp.status);
    return;
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
  if (!raw) return 'Unknown';
  return String(raw).replace(/[`'"]/g, '').replace(/\s+/g, ' ').trim()
    .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') || 'Unknown';
}
