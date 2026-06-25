// Vercel Serverless Function — Flush webhook queue into contacts.js
// Called by Vercel cron every 5 minutes, or manually via GET/POST with ?key=ADMIN_PASSWORD
// Reads tiny queue.js → reads big contacts.js via Blob API → merges → writes → clears queue

export default async function handler(req, res) {
  const key = req.query.key;
  const expected = process.env.ADMIN_PASSWORD;

  // Auth: cron passes key, or check for Vercel cron header
  const isCron = req.headers['x-vercel-cron'] === '1';
  if (!isCron && (!key || key !== expected)) {
    return res.status(401).json({ error: 'Invalid key' });
  }

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });

  const repo = process.env.GITHUB_REPO || 'digistex4u/pramogh-crm-hub';
  const ghHeaders = {
    'Authorization': `Bearer ${githubToken}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'pramogh-crm-flush',
  };

  try {
    // ── 1. Read queue ──
    const queuePath = 'public/queue.js';
    const queueUrl = `https://api.github.com/repos/${repo}/contents/${queuePath}`;
    const queueResp = await fetch(queueUrl, { headers: ghHeaders });

    let queue = [];
    let queueSha = null;

    if (queueResp.ok) {
      const queueFile = await queueResp.json();
      queueSha = queueFile.sha;
      if (queueFile.content) {
        const content = Buffer.from(queueFile.content, 'base64').toString('utf-8');
        const match = content.match(/window\.PRAMOGH_QUEUE\s*=\s*(\[[\s\S]*\])\s*;?/);
        if (match) {
          try { queue = JSON.parse(match[1]); } catch (e) {}
        }
      }
    }

    if (!queue.length) {
      return res.status(200).json({ flushed: 0, message: 'Queue empty' });
    }

    console.log(`Flush: processing ${queue.length} queued contacts`);

    // ── 2. Read contacts.js (Blob API for >1MB) ──
    const contactsPath = 'public/contacts.js';
    const contactsUrl = `https://api.github.com/repos/${repo}/contents/${contactsPath}`;
    const contactsResp = await fetch(contactsUrl, { headers: ghHeaders });

    let existingContacts = [];
    let contactsSha = null;

    if (contactsResp.ok) {
      const contactsFile = await contactsResp.json();
      contactsSha = contactsFile.sha;

      let content = '';

      if (contactsFile.content) {
        content = Buffer.from(contactsFile.content, 'base64').toString('utf-8');
      } else if (contactsFile.sha) {
        // File > 1MB — use Blob API
        console.log('contacts.js > 1MB, using Blob API');
        const blobUrl = `https://api.github.com/repos/${repo}/git/blobs/${contactsFile.sha}`;
        const blobResp = await fetch(blobUrl, { headers: ghHeaders });
        if (blobResp.ok) {
          const blobData = await blobResp.json();
          if (blobData.content) {
            content = Buffer.from(blobData.content, 'base64').toString('utf-8');
          }
        } else {
          console.error('Blob API failed:', blobResp.status);
        }
      }

      if (content) {
        const match = content.match(/window\.PRAMOGH_CONTACTS\s*=\s*(\[[\s\S]*\])\s*;?/);
        if (match) {
          try { existingContacts = JSON.parse(match[1]); } catch (e) {}
        }
      }

      // Safety: if file is large but parsed 0 contacts, abort
      if (existingContacts.length === 0 && contactsFile.size > 1000) {
        console.error('SAFETY ABORT: contacts.js is ' + contactsFile.size + ' bytes but parsed 0');
        return res.status(500).json({
          error: 'Safety abort: could not read ' + contactsFile.size + ' byte contacts.js',
          queued: queue.length,
        });
      }
    }

    // ── 3. Merge queued contacts ──
    const contactMap = new Map();
    for (const c of existingContacts) {
      if (c.phone) contactMap.set(c.phone, c);
    }

    let newCount = 0;
    let updateCount = 0;
    const logEntries = [];

    for (const q of queue) {
      if (!q.phone) continue;
      const action = contactMap.has(q.phone) ? 'updated' : 'new';

      if (action === 'updated') {
        const existing = contactMap.get(q.phone);
        const merged = { ...existing };
        for (const [k, v] of Object.entries(q)) {
          if (v !== undefined && v !== '' && v !== null && k !== '_queued_at' && k !== '_received_fields') {
            merged[k] = v;
          }
        }
        contactMap.set(q.phone, merged);
        updateCount++;
      } else {
        // Remove queue metadata before storing
        const clean = { ...q };
        delete clean._queued_at;
        delete clean._received_fields;
        contactMap.set(q.phone, clean);
        newCount++;
      }

      logEntries.push({
        ts: q._queued_at || new Date().toISOString(),
        phone: q.phone,
        name: q.name || '',
        email: q.email || '',
        action,
        status: 'ok',
        total: contactMap.size,
      });
    }

    const finalContacts = Array.from(contactMap.values());

    // ── 4. Write contacts.js ──
    const contactsContent = '// Pramogh CRM Contacts Database\n// Flush update: ' + new Date().toISOString() + '\n// ' + finalContacts.length + ' unique contacts\nwindow.PRAMOGH_CONTACTS = ' + JSON.stringify(finalContacts) + ';\n';

    const contactsPutBody = {
      message: `Flush: +${newCount} new, ~${updateCount} updated (${finalContacts.length} total)`,
      content: Buffer.from(contactsContent).toString('base64'),
      branch: 'main',
    };
    if (contactsSha) contactsPutBody.sha = contactsSha;

    const putResp = await fetch(contactsUrl, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify(contactsPutBody),
    });

    if (!putResp.ok) {
      const errText = await putResp.text();
      console.error('Contacts push failed:', putResp.status, errText.slice(0, 200));
      return res.status(500).json({
        error: 'Contacts push failed: ' + putResp.status,
        queued: queue.length,
      });
    }

    const putResult = await putResp.json();
    console.log(`Flush: contacts.js updated — ${finalContacts.length} contacts, commit ${putResult.content?.sha?.slice(0, 7)}`);

    // ── 5. Clear queue ──
    const emptyQueue = '// Pramogh CRM Webhook Queue — pending contacts awaiting flush\n// Updated: ' + new Date().toISOString() + '\n// 0 queued\nwindow.PRAMOGH_QUEUE = [];\n';

    // Re-read queue SHA (it may have changed if webhooks wrote to it during flush)
    let latestQueueSha = queueSha;
    const queueRecheck = await fetch(queueUrl, { headers: ghHeaders });
    if (queueRecheck.ok) {
      const recheckData = await queueRecheck.json();
      latestQueueSha = recheckData.sha;
    }

    const clearBody = {
      message: `Queue flushed: ${queue.length} contacts processed`,
      content: Buffer.from(emptyQueue).toString('base64'),
      branch: 'main',
    };
    if (latestQueueSha) clearBody.sha = latestQueueSha;

    const clearResp = await fetch(queueUrl, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify(clearBody),
    });

    if (!clearResp.ok) {
      // Non-critical: contacts already saved, queue will just re-process (dedup by phone handles it)
      console.error('Queue clear failed:', clearResp.status, '— will re-process on next flush (dedup safe)');
    }

    // ── 6. Append to webhook log (fire-and-forget) ──
    appendToWebhookLog(logEntries, repo, ghHeaders).catch(e => console.error('Log write:', e.message));

    return res.status(200).json({
      success: true,
      flushed: queue.length,
      new: newCount,
      updated: updateCount,
      total: finalContacts.length,
      commit: putResult.content?.sha?.slice(0, 7),
    });

  } catch (err) {
    console.error('Flush error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── Append batch log entries to webhook-log.js ──
async function appendToWebhookLog(entries, repo, headers) {
  if (!entries.length) return;

  const filePath = 'public/webhook-log.js';
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    let existingLog = [];
    let sha = null;

    const getResp = await fetch(apiUrl, { headers });
    if (getResp.ok) {
      const fileData = await getResp.json();
      sha = fileData.sha;
      if (fileData.content) {
        const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
        const match = content.match(/window\.PRAMOGH_WEBHOOK_LOG\s*=\s*(\[[\s\S]*\])\s*;?/);
        if (match) {
          try { existingLog = JSON.parse(match[1]); } catch (e) {}
        }
      }
    }

    // Prepend new entries, cap at 500
    for (const e of entries.reverse()) {
      existingLog.unshift(e);
    }
    if (existingLog.length > 500) existingLog = existingLog.slice(0, 500);

    const jsContent = '// Pramogh CRM Webhook Activity Log\n// Updated: ' + new Date().toISOString() + '\n// ' + existingLog.length + ' entries\nwindow.PRAMOGH_WEBHOOK_LOG = ' + JSON.stringify(existingLog) + ';\n';

    const putBody = {
      message: 'Log: flush ' + entries.length + ' entries',
      content: Buffer.from(jsContent).toString('base64'),
      branch: 'main',
    };
    if (sha) putBody.sha = sha;

    const putResp = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(putBody) });
    if (putResp.ok) return;

    if (putResp.status === 409 && attempt < 1) {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    console.error('Webhook log push failed:', putResp.status);
    return;
  }
}
