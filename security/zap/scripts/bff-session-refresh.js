// ZAP HTTP Sender script — BFF session-cookie auth + refresh (feature 031, T005).
// Contract: specs/031-dast-zap-scanning/contracts/zap-scan-contract.md.
//
// WHAT: the BFF (mcm-bff-service-nonsecure) authenticates via ONE HttpOnly cookie, `mcm_session_id`,
// backed by a real Redis session that holds the member's tokens server-side (feature 085) — a bearer
// token is refused in every environment. `scripts/dast-bff-login.mjs` performs the OAuth Auth-Code +
// PKCE login out-of-band and writes that cookie to `security/zap/reports/.auth.local.json`
// (gitignored). This script:
//   1. loads that cookie file once, and attaches the session cookie to every request to the BFF host;
//   2. on a 401 from the BFF, calls `POST /bff-api/auth/refresh` with the session cookie. The BFF
//      renews the access token itself as the scan outlives its 300s TTL, so a 401 normally means the
//      session ended; the refresh attempt only reports whether it is still live (FR-013).
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

// cookies: { mcm_session_id }
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
  return c.mcm_session_id ? 'mcm_session_id=' + c.mcm_session_id : '';
}

function isBffHost(host) {
  return host === BFF_HOST;
}

// Call POST /bff-api/auth/refresh with the session cookie. Returns true if the session is still live.
function refreshSession(scheme, host, port) {
  var c = loadCookies();
  if (!c.mcm_session_id) return false;
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
    return true;
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
