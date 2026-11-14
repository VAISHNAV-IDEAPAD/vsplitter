// Social login settings for Dhondiyal_G.
// App IDs are public client identifiers (safe to commit). Never put an app secret in this file.
// Can be set here, or configured live in the Dhondiyal_G UI / Admin Console (persisted in localStorage).
(function () {
  var stored = {};
  try {
    stored = JSON.parse(localStorage.getItem('dhondiyal_g_oauth_config') || localStorage.getItem('vsplitter_oauth_config') || '{}');
  } catch (e) {}

  window.DHONDIYAL_G_AUTH = {
    facebookAppId: (stored.facebookAppId || '').trim(), // e.g. '123456789012345' from https://developers.facebook.com
    instagramAppId: (stored.instagramAppId || '').trim() // Instagram App ID
  };
  window.VSPLITTER_AUTH = window.DHONDIYAL_G_AUTH;

  window.setFacebookAppId = function (id) {
    var cleanId = String(id || '').trim();
    window.DHONDIYAL_G_AUTH.facebookAppId = cleanId;
    window.VSPLITTER_AUTH.facebookAppId = cleanId;
    try {
      var cur = JSON.parse(localStorage.getItem('dhondiyal_g_oauth_config') || localStorage.getItem('vsplitter_oauth_config') || '{}');
      cur.facebookAppId = cleanId;
      localStorage.setItem('dhondiyal_g_oauth_config', JSON.stringify(cur));
      localStorage.setItem('vsplitter_oauth_config', JSON.stringify(cur));
    } catch (_) {}
    if (window.initFacebookSdk && cleanId) {
      window.initFacebookSdk(cleanId);
    }
    return cleanId;
  };
})();
