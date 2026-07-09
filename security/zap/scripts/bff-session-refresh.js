// ZAP HTTP Sender script — BFF session-cookie auth + refresh (feature 031, T005).
// Contract: specs/031-dast-zap-scanning/contracts/zap-scan-contract.md.
//
// WHAT: the BFF (mcm-bff-service-nonsecure) authenticates via three HttpOnly cookies
// (`mcm_access_token`, `mcm_refresh_token`, `mcm_session_id`) backed by a real Redis session — a raw
// bearer token is insufficient. `scripts/dast-bff-login.mjs` performs the OAuth Auth-Code + PKCE
// login out-of-band and writes those cookies to `security/zap/reports/.auth.local.json` (gitignored).
// This script:
//   1. loads that cookie file once, and attaches the current cookies to every request to the BFF host;
//   2. on a 401 from the BFF, calls `POST /bff-api/auth/refresh` with the refresh cookie, updates the
//      access-token cookie in memory, and lets ZAP re-issue the request — keeping the session valid
//      across the 300s access-token TTL for the full scan (FR-013).
//
// SECURITY: never logs cookie values or the refresh token (FR-013, SC-008). The cookie file is
// gitignored and produced from env-sourced credentials — no literal secret here.

var HttpSender = Java.type('org.parosproxy.paros.network.HttpSender');
var HttpRequestHeader = Java.type('org.parosproxy.paros.network.HttpRequestHeader');
var HttpHeader = Java.type('org.parosproxy.paros.network.HttpHeader');
var HttpMessage = Java.type('org.parosproxy.paros.network.HttpMessage');
var URI = Java.type('org.apache.commons.httpclient.URI');
var Files = Java.type('java.nio.file.Files');
var Paths = Java.type('java.nio.file.Paths');
var System = Java.type('java.lang.System');

var BFF_HOST = 'mcm-bff-service-nonsecure';
// Path is inside the ZAP container; zap-scan.mjs mounts security/zap/ at /zap/wrk/. The cookie file
// lives at the mount root (NOT under reports/) so it is never uploaded in the CI report artifact.
var COOKIE_FILE = env('DAST_BFF_COOKIE_FILE', '/zap/wrk/.auth.local.json');
var REFRESH_PATH = '/bff-api/auth/refresh';

// cookies: { mcm_access_token, mcm_refresh_token, mcm_session_id }
var cookies = null;

function env(name, fallback) {
  var v = System.getenv(name);
  return v !== null && v !== '' ? v : (fallback || null);
}

function loadCookies() {
  if (cookies !== null) return cookies;
  try {
    var raw = new java.lang.String(Files.readAllBytes(Paths.get(COOKIE_FILE)), 'UTF-8');
    cookies = JSON.parse(raw);
  } catch (e) {
    print('[bff-session-refresh] WARNING: could not read cookie file ' + COOKIE_FILE + ' — BFF requests will be unauthenticated. Run dast-bff-login.mjs first.');
    cookies = {};
  }
  return cookies;
}

function cookieHeader() {
  var c = loadCookies();
  var parts = [];
  if (c.mcm_access_token) parts.push('mcm_access_token=' + c.mcm_access_token);
  if (c.mcm_refresh_token) parts.push('mcm_refresh_token=' + c.mcm_refresh_token);
  if (c.mcm_session_id) parts.push('mcm_session_id=' + c.mcm_session_id);
  return parts.join('; ');
}

function isBffHost(host) {
  return host === BFF_HOST;
}

// Call POST /bff-api/auth/refresh with the current cookies; parse Set-Cookie for a new access token.
// Returns true if the access-token cookie was updated.
function refreshSession(scheme, host, port) {
  var c = loadCookies();
  if (!c.mcm_refresh_token || !c.mcm_session_id) return false;
  try {
    var url = scheme + '://' + host + ':' + port + REFRESH_PATH;
    var msg = new HttpMessage();
    var reqHeader = new HttpRequestHeader(HttpRequestHeader.POST, new URI(url, false), HttpHeader.HTTP11);
    reqHeader.setHeader('Cookie', cookieHeader());
    reqHeader.setHeader(HttpHeader.CONTENT_TYPE, 'application/json');
    msg.setRequestHeader(reqHeader);
    msg.setRequestBody('{}');
    msg.getRequestHeader().setContentLength(msg.getRequestBody().length());

    var sender = new HttpSender(HttpSender.MANUAL_REQUEST_INITIATOR);
    sender.sendAndReceive(msg, false);

    if (msg.getResponseHeader().getStatusCode() !== 200) {
      print('[bff-session-refresh] WARNING: refresh returned HTTP ' + msg.getResponseHeader().getStatusCode());
      return false;
    }
    // Update in-memory cookies from Set-Cookie headers (access + refresh may both rotate).
    var setCookies = msg.getResponseHeader().getHeaderValues('Set-Cookie');
    var updated = false;
    for (var i = 0; i < setCookies.length; i++) {
      var sc = String(setCookies[i]);
      var m = sc.match(/^\s*(mcm_[a-z_]+)=([^;]+)/);
      if (m) { c[m[1]] = m[2]; if (m[1] === 'mcm_access_token') updated = true; }
    }
    return updated;
  } catch (e) {
    print('[bff-session-refresh] WARNING: refresh failed: ' + e);
    return false;
  }
}

function sendingRequest(msg, initiator, helper) {
  var host = msg.getRequestHeader().getHostName();
  if (!isBffHost(host)) return;
  var ch = cookieHeader();
  if (ch !== '') msg.getRequestHeader().setHeader('Cookie', ch);
}

function responseReceived(msg, initiator, helper) {
  var host = msg.getRequestHeader().getHostName();
  if (!isBffHost(host)) return;
  if (msg.getResponseHeader().getStatusCode() === 401) {
    var uri = msg.getRequestHeader().getURI();
    refreshSession(uri.getScheme(), host, uri.getPort() > 0 ? uri.getPort() : 3000);
  }
}
