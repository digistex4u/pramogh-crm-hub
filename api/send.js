export const config = { runtime: 'edge' };

function getChannels() {
  try {
    return JSON.parse(process.env.WATI_CHANNELS || '{}');
  } catch (e) {
    return {};
  }
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await request.json();
  const { channelId, phone, type, message, templateName, broadcastName } = body;

  if (!channelId || !phone) {
    return new Response(JSON.stringify({ error: 'Missing channelId or phone' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const channels = getChannels();
  const channel = channels[channelId];

  if (!channel) {
    return new Response(JSON.stringify({ error: 'Channel not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const baseUrl = channel.url.replace(/\/$/, '');
  const token = channel.token;

  try {
    let endpoint, payload;

    if (type === 'template') {
      endpoint = `${baseUrl}/api/v1/sendTemplateMessage`;
      payload = {
        broadcast_name: broadcastName || 'pramogh_broadcast',
        template_name: templateName,
        receivers: [{ whatsappNumber: phone.replace(/^\+/, ''), customParams: [] }],
      };
    } else {
      endpoint = `${baseUrl}/api/v1/sendSessionMessage/${phone.replace(/^\+/, '')}`;
      payload = { messageText: message };
    }

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const respText = await resp.text();
    let respData;
    try {
      respData = JSON.parse(respText);
    } catch (e) {
      respData = { raw: respText.slice(0, 200) };
    }

    if (resp.ok) {
      return new Response(JSON.stringify({ ok: true, data: respData }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      // Return error reason but NEVER the token
      const reason = respData.message || respData.error || respData.result || `HTTP ${resp.status}`;
      return new Response(JSON.stringify({ ok: false, reason }), {
        status: resp.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, reason: err.message || 'Network error' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
