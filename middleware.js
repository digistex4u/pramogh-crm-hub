// Vercel Edge Middleware — protects the entire site with a session cookie
// Users login once via /api/auth, then browse freely for 24 hours

export const config = {
  matcher: ['/((?!api/auth|favicon.ico).*)'],
};

export default function middleware(request) {
  const cookie = request.cookies.get('pramogh_session');
  const sitePassword = process.env.SITE_PASSWORD;

  // If no password is set, skip auth entirely
  if (!sitePassword) {
    return;
  }

  // Check session cookie
  if (cookie) {
    try {
      const data = JSON.parse(atob(cookie.value));
      // Check if session is less than 24 hours old
      if (data.ts && Date.now() - data.ts < 86400000) {
        return; // Authorized
      }
    } catch (e) {
      // Invalid cookie, fall through to login
    }
  }

  // For API calls, return 401
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // For page requests, show login page
  return new Response(loginHTML(), {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

function loginHTML() {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pramogh CRM — Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#0a0a0f;color:#e8e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{text-align:center;max-width:400px;padding:40px}
.gem{width:64px;height:64px;background:conic-gradient(from 0deg,#c9a44c,#e8c868,#c9a44c,#a07830,#c9a44c);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;box-shadow:0 0 40px rgba(201,164,76,0.3);margin:0 auto 20px}
h1{font-size:28px;background:linear-gradient(135deg,#e8c868,#c9a44c);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px}
.sub{font-size:11px;color:#8888a0;letter-spacing:3px;text-transform:uppercase;margin-bottom:30px}
input{width:100%;background:#1a1a28;border:1px solid #2a2a3a;border-radius:10px;padding:12px 16px;color:#e8e8f0;font-size:14px;outline:none;text-align:center;margin-bottom:16px}
input:focus{border-color:#c9a44c}
button{width:100%;padding:12px;background:#c9a44c;color:#000;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer}
button:hover{background:#e8c868}
.err{color:#ef4444;font-size:12px;margin-top:8px;display:none}
.foot{margin-top:24px;font-size:10px;color:#5a5a70}
</style></head><body>
<div class="card">
<div class="gem">💎</div>
<h1>PRAMOGH</h1>
<p class="sub">CRM + WhatsApp Command Center</p>
<input id="pw" type="password" placeholder="Enter site password" onkeydown="if(event.key==='Enter')login()"/>
<button onclick="login()">🔓 Login</button>
<p class="err" id="err"></p>
<p class="foot">🔒 Protected deployment · API keys secured server-side</p>
</div>
<script>
async function login(){
  const pw=document.getElementById('pw').value;
  if(!pw)return;
  const r=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
  if(r.ok){location.reload();}
  else{const e=document.getElementById('err');e.textContent='Wrong password';e.style.display='block';}
}
</script></body></html>`;
}
