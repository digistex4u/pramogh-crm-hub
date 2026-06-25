// Vercel Serverless Function — receives real-time contact pushes from Freshsales
// v3: QUEUE-BASED — appends to tiny queue.js instead of 16MB contacts.js
// A cron job (/api/flush-queue) merges the queue into contacts.js every 5 minutes
// Automations still fire in real-time (no delay)

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

    // ── Normalize fields ──
    const data = {};
    for (const [k, v] of Object.entries(raw)) {
      const lk = k.toLowerCase().trim();
      data[lk] = v;
      // Freshsales prefixes: contact_cf_xxx → xxx, contact_xxx → xxx
      if (lk.startsWith('contact_cf_')) {
        data[lk.slice(11)] = v;
      } else if (lk.startsWith('contact_')) {
        data[lk.slice(8)] = v;
      }
    }

    console.log('Webhook fields:', Object.keys(raw).join(', '));

    // ── Extract phone ──
    const phone = cleanPhone(
      data['mobile'] || data['mobile number'] || data['mobile_number'] ||
      data['contact number'] || data['contact_number'] || data['phone'] ||
      data['phone number'] || data['phone_number'] || data['whatsapp'] ||
      data['work number'] || data['work_number'] ||
      findPhoneInValues(raw) || ''
    );

    if (!phone) {
      return res.status(400).json({
        error: 'No valid phone number found',
        received_fields: Object.keys(raw),
      });
    }

    // ── Build contact object ──
    const contact = { phone };

    // Name
    const fname = data['first name'] || data['first_name'] || data['firstname'] || '';
    const lname = data['last name'] || data['last_name'] || data['lastname'] || '';
    const fullname = data['display name'] || data['display_name'] || data['name'] || data['full name'] || data['full_name'] || '';
    contact.name = cleanName(fullname || [fname, lname].filter(Boolean).join(' ') || 'Unknown');

    // Email
    const email = data['email'] || data['email id'] || data['email_id'] || data['email address'] || data['email_address'] || '';
    if (email) contact.email = String(email).toLowerCase();

    // Location
    const city = data['city'] || data['address.city'] || '';
    const state = data['state'] || data['address.state'] || '';
    if (city) contact.city = city;
    if (state) contact.state = state;

    // Sales owner
    const owner = data['sales owner'] || data['sales_owner'] || data['owner'] || data['owner_name'] || data['assigned to'] || '';
    if (owner) contact.sales_owner = typeof owner === 'object' ? (owner.display_name || owner.name || JSON.stringify(owner)) : owner;

    // Source
    const source = data['lead source'] || data['lead_source'] || data['source'] || data['primary_source'] || '';
    if (source) contact.source = source;
    const subSource = data['sub_source'] || data['sub source'] || '';
    if (subSource) contact.sub_source = subSource;

    // Stage
    const stage = data['lifecycle stage'] || data['lifecycle_stage'] || data['stage'] || data['lead stage'] || data['lead_stage'] || data['status'] || data['contact_status_name'] || '';
    if (stage) contact.stage = stage;

    // Customer type
    const custType = data['customer_type'] || data['customer type'] || '';
    if (custType) contact.customer_type = custType;

    // Created at
    const createdAt = data['created_at'] || '';
    if (createdAt) contact.created_at = createdAt;

    // Freshsales ID
    const fsId = data['id'] || data['contact id'] || data['contact_id'] || '';
    if (fsId) contact.fs_id = fsId;

    // Custom fields (scan all)
    for (const [k, v] of Object.entries(data)) {
      if (!v || v === '') continue;
      const lk = k.toLowerCase();
      if (lk.includes('gemstone') || lk.includes('gem type') || lk.includes('product interest'))
        contact.gemstone = v;
      if (lk.includes('lost reason') || lk.includes('lost_reason') || lk.includes('reason_lost'))
        contact.lost_reason = v;
      if (lk.includes('tag')) contact.tags = v;
      if (lk.includes('deal value') || lk.includes('deal_value'))
        contact.deal_value = parseFloat(v) || 0;
      if (lk.includes('order count') || lk.includes('order_count') || lk.includes('total_order_count'))
        contact.order_count = parseInt(v) || 0;
      if (lk.includes('won amount') || lk.includes('won_amount') || lk.includes('total_won'))
        contact.won_amount = parseFloat(v) || 0;
    }

    contact.updated_at = new Date().toISOString();

    // Queue metadata (stripped at flush time)
    contact._queued_at = new Date().toISOString();
    contact._received_fields = Object.keys(raw).slice(0, 15);

    // ── Append to queue.js (tiny file, fast) ──
    const queueResult = await appendToQueue(contact, repo, githubToken);

    // ── Fire automations immediately (real-time WhatsApp) ──
    let autoResults = [];
    try {
      autoResults = await evaluateAutomations(contact, 'both', repo, githubToken);
    } catch (autoErr) {
      console.error('Automation error:', autoErr.message);
    }

    return res.status(200).json({
      success: true,
      phone: contact.phone,
      name: contact.name,
      queued: true,
      queue_size: queueResult.total,
      automations_fired: autoResults.length,
      automations: autoResults.map(r => ({ name: r.name, sent: r.sent, error: r.error })),
    });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════
// QUEUE: append contact to tiny queue.js file
// ═══════════════════════════════════════════════

async function appendToQueue(contact, repo, token, retries = 5) {
  const filePath = 'public/queue.js';
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'pramogh-crm-queue',
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    let queue = [];
    let sha = null;

    const getResp = await fetch(apiUrl, { headers });
    if (getResp.ok) {
      const fileData = await getResp.json();
      sha = fileData.sha;
      if (fileData.content) {
        const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
        const match = content.match(/window\.PRAMOGH_QUEUE\s*=\s*(\[[\s\S]*\])\s*;?/);
        if (match) {
          try { queue = JSON.parse(match[1]); } catch (e) {}
        }
      }
    }

    // Dedup: if same phone already in queue, merge (keep latest data)
    const existing = queue.findIndex(q => q.phone === contact.phone);
    if (existing >= 0) {
      queue[existing] = { ...queue[existing], ...contact };
    } else {
      queue.push(contact);
    }

    const jsContent = '// Pramogh CRM Webhook Queue — pending contacts awaiting flush\n// Updated: ' + new Date().toISOString() + '\n// ' + queue.length + ' queued\nwindow.PRAMOGH_QUEUE = ' + JSON.stringify(queue) + ';\n';

    const putBody = {
      message: 'Queue: +' + contact.phone + ' (' + contact.name + ') [' + queue.length + ' pending]',
      content: Buffer.from(jsContent).toString('base64'),
      branch: 'main',
    };
    if (sha) putBody.sha = sha;

    const putResp = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(putBody) });
    if (putResp.ok) {
      return { total: queue.length };
    }

    if (putResp.status === 409 && attempt < retries - 1) {
      // SHA conflict — retry with backoff
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
      continue;
    }

    const err = await putResp.text();
    throw new Error('Queue push failed: ' + putResp.status + ' ' + err.slice(0, 200));
  }
}

// ═══════════════════════════════════════════════
// AUTOMATION ENGINE (same as before)
// ═══════════════════════════════════════════════

async function evaluateAutomations(contact, contactAction, repo, githubToken) {
  const ghHeaders = {
    'Authorization': `Bearer ${githubToken}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'pramogh-crm-automation',
  };

  const automations = await readGitHubFile(
    `https://api.github.com/repos/${repo}/contents/public/automations.js`,
    ghHeaders,
    /window\.PRAMOGH_AUTOMATIONS\s*=\s*(\[[\s\S]*\])\s*;?/
  );

  if (!automations || !automations.length) return [];

  const recentLog = await readGitHubFile(
    `https://api.github.com/repos/${repo}/contents/public/automation-log.js`,
    ghHeaders,
    /window\.PRAMOGH_AUTOMATION_LOG\s*=\s*(\[[\s\S]*\])\s*;?/
  );

  const results = [];

  for (const auto of automations) {
    if (!auto.enabled) continue;

    // Cooldown check
    if (auto.cooldown_hours && auto.cooldown_hours > 0 && recentLog) {
      const cooldownMs = auto.cooldown_hours * 3600000;
      const recentFire = recentLog.find(
        e => e.automation_id === auto.id &&
             e.phone === contact.phone &&
             e.status === 'sent' &&
             (Date.now() - new Date(e.ts).getTime()) < cooldownMs
      );
      if (recentFire) continue;
    }

    // Evaluate conditions
    if (!evaluateConditions(auto.conditions, contact)) continue;

    // Fire
    const fireResult = await fireAutomation(auto, contact);
    results.push(fireResult);
  }

  // Log results
  if (results.length > 0) {
    appendAutomationLog(results, contact, repo, githubToken, ghHeaders)
      .catch(e => console.error('Automation log error:', e.message));
  }

  return results;
}

function evaluateConditions(conditions, contact) {
  if (!conditions || !conditions.length) return true;

  for (const cond of conditions) {
    const { field, operator, value } = cond;
    const contactVal = getContactField(contact, field);

    switch (operator) {
      case 'equals':
        if (String(contactVal || '').toLowerCase() !== String(value || '').toLowerCase()) return false;
        break;
      case 'not_equals':
        if (String(contactVal || '').toLowerCase() === String(value || '').toLowerCase()) return false;
        break;
      case 'contains':
        if (!String(contactVal || '').toLowerCase().includes(String(value || '').toLowerCase())) return false;
        break;
      case 'not_contains':
        if (String(contactVal || '').toLowerCase().includes(String(value || '').toLowerCase())) return false;
        break;
      case 'greater_than':
        if (parseFloat(contactVal || 0) <= parseFloat(value || 0)) return false;
        break;
      case 'less_than':
        if (parseFloat(contactVal || 0) >= parseFloat(value || 0)) return false;
        break;
      case 'is_empty':
        if (contactVal !== undefined && contactVal !== null && contactVal !== '') return false;
        break;
      case 'is_not_empty':
        if (contactVal === undefined || contactVal === null || contactVal === '') return false;
        break;
      case 'in': {
        const vals = String(value || '').split(',').map(v => v.trim().toLowerCase());
        if (!vals.includes(String(contactVal || '').toLowerCase())) return false;
        break;
      }
      case 'not_in': {
        const vals = String(value || '').split(',').map(v => v.trim().toLowerCase());
        if (vals.includes(String(contactVal || '').toLowerCase())) return false;
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

function getContactField(contact, field) {
  if (contact[field] !== undefined) return contact[field];
  const aliases = { 'status': 'stage', 'product': 'gemstone', 'product_name': 'gemstone', 'owner': 'sales_owner' };
  if (aliases[field] && contact[aliases[field]] !== undefined) return contact[aliases[field]];
  return undefined;
}

async function fireAutomation(auto, contact) {
  const actionCfg = auto.action || {};
  const result = {
    automation_id: auto.id, name: auto.name, phone: contact.phone,
    contact_name: contact.name, ts: new Date().toISOString(),
  };

  try {
    const channels = JSON.parse(process.env.WATI_CHANNELS || '{}');
    const channel = channels[actionCfg.channel_id];
    if (!channel) { result.status = 'error'; result.error = 'Channel not found'; result.sent = false; return result; }

    const baseUrl = channel.url.replace(/\/$/, '');
    const token = channel.token;

    const customParams = [];
    if (actionCfg.custom_params && Array.isArray(actionCfg.custom_params)) {
      for (const param of actionCfg.custom_params) {
        const val = getContactField(contact, param.field);
        customParams.push({ name: param.name, value: val != null ? String(val) : '' });
      }
    }

    const payload = {
      broadcast_name: actionCfg.broadcast_name || 'pramogh_auto_' + auto.id,
      template_name: actionCfg.template_name,
      receivers: [{ whatsappNumber: contact.phone.replace(/^\+/, ''), customParams }],
    };

    console.log(`Auto "${auto.name}" → "${actionCfg.template_name}" to ${contact.phone}`);

    const resp = await fetch(`${baseUrl}/api/v1/sendTemplateMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}` },
      body: JSON.stringify(payload),
    });

    if (resp.ok) {
      result.status = 'sent'; result.sent = true; result.template = actionCfg.template_name;
    } else {
      const errText = await resp.text();
      let reason = `HTTP ${resp.status}`;
      try { const ej = JSON.parse(errText); reason = ej.message || ej.error || reason; } catch (e) {}
      result.status = 'failed'; result.sent = false; result.error = reason;
    }
  } catch (err) {
    result.status = 'error'; result.sent = false; result.error = err.message;
  }
  return result;
}

// ── GitHub helpers ──

async function readGitHubFile(url, headers, regex) {
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.content) return [];
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const match = content.match(regex);
    if (match) { try { return JSON.parse(match[1]); } catch (e) {} }
  } catch (e) {}
  return [];
}

async function appendAutomationLog(results, contact, repo, githubToken, ghHeaders) {
  const filePath = 'public/automation-log.js';
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    let existingLog = [];
    let sha = null;

    const getResp = await fetch(apiUrl, { headers: ghHeaders });
    if (getResp.ok) {
      const fileData = await getResp.json();
      sha = fileData.sha;
      if (fileData.content) {
        const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
        const match = content.match(/window\.PRAMOGH_AUTOMATION_LOG\s*=\s*(\[[\s\S]*\])\s*;?/);
        if (match) { try { existingLog = JSON.parse(match[1]); } catch (e) {} }
      }
    }

    for (const r of results.reverse()) {
      existingLog.unshift({
        ts: r.ts, automation_id: r.automation_id, automation_name: r.name,
        phone: r.phone, contact_name: r.contact_name, status: r.status,
        template: r.template || '', error: r.error || '',
      });
    }
    if (existingLog.length > 500) existingLog = existingLog.slice(0, 500);

    const jsContent = '// Pramogh CRM Automation Execution Log\n// Updated: ' + new Date().toISOString() + '\n// ' + existingLog.length + ' entries\nwindow.PRAMOGH_AUTOMATION_LOG = ' + JSON.stringify(existingLog) + ';\n';

    const putBody = { message: 'AutoLog: ' + results.length + ' fired for ' + contact.phone, content: Buffer.from(jsContent).toString('base64'), branch: 'main' };
    if (sha) putBody.sha = sha;

    const putResp = await fetch(apiUrl, { method: 'PUT', headers: ghHeaders, body: JSON.stringify(putBody) });
    if (putResp.ok) return;
    if (putResp.status === 409 && attempt < 1) { await new Promise(r => setTimeout(r, 500)); continue; }
    return;
  }
}

// ── Utility ──

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
