// Vercel Serverless Function — Hourly Freshsales → contacts.js sync
// Cron: runs every hour via vercel.json crons config
// Flow: filtered_search (delta IDs) → batch fetch full details → merge → push to GitHub
//
// Env vars needed:
//   FRESHSALES_DOMAIN    — e.g. "pramogh" (from pramogh.myfreshworks.com)
//   FRESHSALES_API_KEY   — from Personal Settings → API Settings in Freshsales
//   GITHUB_TOKEN         — fine-grained PAT with repo Contents write access
//   CRON_SECRET          — Vercel cron secret (auto-sent by Vercel crons)
//   GITHUB_REPO          — optional, defaults to "digistex4u/pramogh-crm-hub"

export default async function handler(req, res) {
  // ── Security: only cron or admin can trigger ──
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  const isAdminTrigger = req.query.key === process.env.ADMIN_PASSWORD;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}` && !isAdminTrigger) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const domain = process.env.FRESHSALES_DOMAIN;
  const apiKey = process.env.FRESHSALES_API_KEY;
  const githubToken = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || 'digistex4u/pramogh-crm-hub';

  if (!domain || !apiKey) {
    return res.status(500).json({ error: 'FRESHSALES_DOMAIN and FRESHSALES_API_KEY not configured' });
  }
  if (!githubToken) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });
  }

  const BASE = `https://${domain}.myfreshworks.com/crm/sales/api`;
  const headers = {
    'Authorization': `Token token=${apiKey}`,
    'Content-Type': 'application/json',
  };

  const log = [];
  const ts = () => new Date().toISOString().slice(11, 19);

  try {
    // ── Step 1: Calculate time window (last 65 minutes, 5 min overlap) ──
    const now = new Date();
    const lookback = new Date(now.getTime() - 65 * 60 * 1000);
    const fromISO = lookback.toISOString().slice(0, 19);
    const toISO = now.toISOString().slice(0, 19);
    log.push(`${ts()} Window: ${fromISO} → ${toISO}`);

    // ── Step 2: Filtered search for recently updated contacts ──
    let allDeltaContacts = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 10) {
      const searchResp = await fetch(
        `${BASE}/filtered_search/contact?per_page=100&page=${page}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            filter_rule: [{
              attribute: 'updated_at',
              operator: 'is_in_the_range',
              value: [fromISO, toISO]
            }]
          })
        }
      );

      if (!searchResp.ok) {
        const errText = await searchResp.text();
        log.push(`${ts()} filtered_search page ${page} failed: ${searchResp.status} ${errText.slice(0, 200)}`);
        break;
      }

      const data = await searchResp.json();
      const contacts = data.contacts || data || [];

      if (Array.isArray(contacts) && contacts.length > 0) {
        allDeltaContacts.push(...contacts);
        log.push(`${ts()} Page ${page}: ${contacts.length} contacts`);
        page++;
        if (contacts.length < 100) hasMore = false;
      } else {
        hasMore = false;
      }
    }

    log.push(`${ts()} Total delta contacts: ${allDeltaContacts.length}`);

    if (allDeltaContacts.length === 0) {
      log.push(`${ts()} No changes detected. Skipping push.`);
      return res.status(200).json({ synced: 0, log });
    }

    // ── Step 3: Batch fetch full details (for custom fields) ──
    const fullContacts = [];
    const batchSize = 5; // concurrent fetches
    const contactIds = allDeltaContacts.map(c => c.id).filter(Boolean);

    for (let i = 0; i < contactIds.length; i += batchSize) {
      const batch = contactIds.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(id =>
          fetch(`${BASE}/contacts/${id}?include=owner`, { headers })
            .then(r => r.ok ? r.json() : null)
        )
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value?.contact) {
          fullContacts.push(result.value.contact);
        }
      }

      // Small delay between batches to respect rate limits
      if (i + batchSize < contactIds.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    log.push(`${ts()} Full details fetched: ${fullContacts.length}/${contactIds.length}`);

    // ── Step 4: Map Freshsales fields → CRM schema ──
    const mappedContacts = fullContacts.map(c => {
      const phone = cleanPhone(c.mobile_number || c.phone || '');
      if (!phone) return null;

      const contact = { phone };

      // Name
      const name = cleanName(
        c.display_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || ''
      );
      if (name) contact.name = name;

      // Email
      if (c.email || (c.emails && c.emails.length)) {
        contact.email = (c.email || c.emails[0]?.value || '').toLowerCase();
      }

      // Location
      if (c.city) contact.city = c.city;
      if (c.state) contact.state = c.state;

      // Sales owner
      if (c.owner) {
        contact.sales_owner = c.owner.display_name || c.owner.email || '';
      } else if (c.sales_owner) {
        contact.sales_owner = c.sales_owner;
      }

      // Lead source
      if (c.lead_source) contact.source = c.lead_source;

      // Lifecycle stage (may be ID or name depending on API version)
      if (c.lifecycle_stage) {
        contact.stage = typeof c.lifecycle_stage === 'object'
          ? c.lifecycle_stage.name
          : c.lifecycle_stage;
      } else if (c.lifecycle_stage_name) {
        contact.stage = c.lifecycle_stage_name;
      }

      // Custom fields — Freshsales prefixes them with cf_
      if (c.custom_field) {
        const cf = c.custom_field;

        // Gemstone — try common field name patterns
        const gemField = cf.cf_gemstone || cf.cf_gemstone_interest || cf.cf_gem_type
          || cf.cf_product || cf.cf_product_interest || cf.cf_interested_in || '';
        if (gemField) contact.gemstone = gemField;

        // Lost reason
        const lostField = cf.cf_lost_reason || cf.cf_reason_lost || cf.cf_close_reason || '';
        if (lostField) contact.lost_reason = lostField;

        // Tags
        const tagField = cf.cf_tags || cf.cf_labels || '';
        if (tagField) contact.tags = tagField;

        // Deal value
        const dealField = cf.cf_deal_value || cf.cf_order_value || cf.cf_amount || '';
        if (dealField) contact.deal_value = parseFloat(dealField) || 0;
      }

      // Dates
      if (c.created_at) contact.created_at = c.created_at;
      if (c.updated_at) contact.updated_at = c.updated_at;

      // Freshsales ID (for reference)
      if (c.id) contact.fs_id = c.id;

      return contact;
    }).filter(Boolean);

    log.push(`${ts()} Mapped contacts: ${mappedContacts.length}`);

    // ── Step 5: Fetch existing contacts.js from GitHub ──
    const filePath = 'public/contacts.js';
    const ghApiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
    const ghHeaders = {
      'Authorization': `Bearer ${githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'pramogh-crm-sync',
    };

    let existingContacts = [];
    let existingSha = null;

    const getResp = await fetch(ghApiUrl, { headers: ghHeaders });
    if (getResp.ok) {
      const fileData = await getResp.json();
      existingSha = fileData.sha;

      // Decode and parse
      const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
      // Extract JSON array from: window.PRAMOGH_CONTACTS = [...];
      const jsonMatch = content.match(/window\.PRAMOGH_CONTACTS\s*=\s*(\[[\s\S]*\])\s*;?/);
      if (jsonMatch) {
        try {
          existingContacts = JSON.parse(jsonMatch[1]);
        } catch (e) {
          log.push(`${ts()} Warning: could not parse existing contacts.js, starting fresh`);
        }
      }
    }

    log.push(`${ts()} Existing contacts: ${existingContacts.length}`);

    // ── Step 6: Merge — upsert by phone number ──
    const contactMap = new Map();
    // Load existing
    for (const c of existingContacts) {
      if (c.phone) contactMap.set(c.phone, c);
    }
    // Upsert new/updated
    let newCount = 0;
    let updateCount = 0;
    for (const c of mappedContacts) {
      if (contactMap.has(c.phone)) {
        // Merge: keep existing fields, overwrite with new non-empty fields
        const existing = contactMap.get(c.phone);
        const merged = { ...existing };
        for (const [key, val] of Object.entries(c)) {
          if (val !== undefined && val !== '' && val !== null) {
            merged[key] = val;
          }
        }
        contactMap.set(c.phone, merged);
        updateCount++;
      } else {
        contactMap.set(c.phone, c);
        newCount++;
      }
    }

    const finalContacts = Array.from(contactMap.values());
    log.push(`${ts()} Merge: ${newCount} new, ${updateCount} updated, ${finalContacts.length} total`);

    // ── Step 7: Push updated contacts.js to GitHub ──
    const jsContent = [
      '// Pramogh CRM Contacts Database',
      `// Auto-synced from Freshsales on ${now.toISOString()}`,
      `// ${finalContacts.length.toLocaleString()} unique contacts`,
      `window.PRAMOGH_CONTACTS = ${JSON.stringify(finalContacts)};`,
      ''
    ].join('\n');

    const putBody = {
      message: `Sync: +${newCount} new, ~${updateCount} updated [${now.toISOString().slice(0, 16)}]`,
      content: Buffer.from(jsContent).toString('base64'),
      branch: 'main',
    };
    if (existingSha) putBody.sha = existingSha;

    const putResp = await fetch(ghApiUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody),
    });

    if (putResp.ok) {
      const result = await putResp.json();
      log.push(`${ts()} ✅ Pushed to GitHub. Commit: ${result.content?.sha?.slice(0, 7)}`);
      log.push(`${ts()} Vercel auto-deploys in ~45s`);

      return res.status(200).json({
        success: true,
        synced: mappedContacts.length,
        new: newCount,
        updated: updateCount,
        total: finalContacts.length,
        commit: result.content?.sha?.slice(0, 7),
        log,
      });
    } else {
      const err = await putResp.text();
      log.push(`${ts()} ❌ GitHub push failed: ${putResp.status} ${err.slice(0, 300)}`);
      return res.status(500).json({ error: 'GitHub push failed', log });
    }

  } catch (err) {
    log.push(`${ts()} ❌ Fatal error: ${err.message}`);
    return res.status(500).json({ error: err.message, log });
  }
}

// ── Helpers ──

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
  return String(raw)
    .replace(/[`'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
