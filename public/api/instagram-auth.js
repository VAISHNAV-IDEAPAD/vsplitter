// Vercel serverless function: exchanges an Instagram login `code` for the user's identity.
// Requires the INSTAGRAM_APP_SECRET environment variable (kept server-side, never in the browser).
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: 'POST only' }));
  }

  const secret = process.env.INSTAGRAM_APP_SECRET;
  if (!secret) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: 'INSTAGRAM_APP_SECRET is not set on the server' }));
  }

  try {
    const { code, redirectUri, clientId } = req.body || {};
    if (!code || !redirectUri || !clientId) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'Missing code, redirectUri or clientId' }));
    }

    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: secret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: tokenData.error_message || 'Instagram rejected the login code' }));
    }

    const meRes = await fetch(`https://graph.instagram.com/me?fields=user_id,username&access_token=${encodeURIComponent(tokenData.access_token)}`);
    const me = await meRes.json();
    if (!me.username) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'Could not read Instagram profile' }));
    }

    return res.end(JSON.stringify({ ok: true, id: me.user_id || tokenData.user_id, username: me.username }));
  } catch (err) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
  }
};
