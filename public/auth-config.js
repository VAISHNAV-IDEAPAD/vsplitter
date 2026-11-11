// Social login settings for V Splitter.
// App IDs are public client identifiers (safe to commit). Never put an app secret in this file.
// Can be set here, or configured live in the V Splitter UI / Admin Console (persisted in localStorage).
(function () {
  var stored = {};
  try {
    stored = JSON.parse(localStorage.getItem('vsplitter_oauth_config') || '{}');
  } catch (e) {}

  window.VSPLITTER_AUTH = {
    facebookAppId: (stored.facebookAppId || '').trim(), // e.g. '123456789012345' from https://developers.facebook.com
    instagramAppId: (stored.instagramAppId || '').trim() // Instagram App ID
  };

  window.setFacebookAppId = function (id) {
    var cleanId = String(id || '').trim();
    window.VSPLITTER_AUTH.facebookAppId = cleanId;
    try {
      var cur = JSON.parse(localStorage.getItem('vsplitter_oauth_config') || '{}');
      cur.facebookAppId = cleanId;
      localStorage.setItem('vsplitter_oauth_config', JSON.stringify(cur));
    } catch (_) {}
    if (window.initFacebookSdk && cleanId) {
      window.initFacebookSdk(cleanId);
    }
    return cleanId;
  };
})();
