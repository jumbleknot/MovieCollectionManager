// ZAP HTTP Sender script — bearer-token auth for the API scan targets (feature 031, T004).
// Contract: specs/031-dast-zap-scanning/contracts/zap-scan-contract.md.
//
// WHAT: injects `Authorization: Bearer <access_token>` into every outgoing request bound for a
// bearer target (mc-service, agent-gateway), minting the token from Keycloak via ROPC
// (grant_type=password). The token is cached and re-minted when the previous one nears expiry or a
// target answers 401 — this transparently survives the 300s access-token TTL across a long scan
// (FR-013). Implemented as an HTTP Sender (not an "authentication" method) because that is the ZAP
// script type that can set a header on EVERY spidered/attacked request and react to a 401; the
// bearer targets are stateless (no server session), so a per-request header is the correct model.
//
// Bearer targets are matched by host so the token is never leaked to the BFF or to Keycloak itself.
//
// SECURITY: never logs the access token, the client secret, or the password (FR-013, SC-008). All
// auth params come from environment variables read at mint time — no literal credential in this file.

var HttpSender = Java.type('org.parosproxy.paros.network.HttpSender');
var HttpRequestHeader = Java.type('org.parosproxy.paros.network.HttpRequestHeader');
var HttpHeader = Java.type('org.parosproxy.paros.network.HttpHeader');
var URI = Java.type('org.apache.commons.httpclient.URI');
var System = Java.type('java.lang.System');

// Hosts whose requests receive the bearer token. Kept in sync with the Compose DNS names used by
// the scan contexts (data-model.md). The BFF (mcm-bff-service-nonsecure) and keycloak-service are
// intentionally excluded — the BFF uses cookies, Keycloak is not a scan target.
var BEARER_HOSTS = ['mc-service', 'movie-assistant-gateway'];

var cachedToken = null;
var cachedExpiryEpochMs = 0;

function env(name, fallback) {
  var v = System.getenv(name);
  return v !== null && v !== '' ? v : (fallback || null);
}

function isBearerHost(host) {
  if (host === null) return false;
  for (var i = 0; i < BEARER_HOSTS.length; i++) {
    if (host === BEARER_HOSTS[i]) return true;
  }
  return false;
}

// Perform a Keycloak ROPC token request and return the access_token, or null on failure.
// Uses a fresh HttpSender so the mint call itself is not recursively decorated by this script.
function mintToken() {
  var tokenUrl = env('KC_TOKEN_URL',
    'http://keycloak-service:8080/realms/grumpyrobot/protocol/openid-connect/token');
  var clientId = env('DAST_ROPC_CLIENT_ID', 'mcm-bff-test');
  var clientSecret = env('DAST_ROPC_CLIENT_SECRET');
  var user = env('DAST_TEST_USER');
  var pass = env('DAST_TEST_PASSWORD');

  if (user === null || pass === null || clientSecret === null) {
    print('[bearer-auth] ERROR: DAST_TEST_USER / DAST_TEST_PASSWORD / DAST_ROPC_CLIENT_SECRET must be set — cannot mint bearer token.');
    return null;
  }

  var form = 'grant_type=password'
    + '&client_id=' + encodeURIComponent(clientId)
    + '&client_secret=' + encodeURIComponent(clientSecret)
    + '&username=' + encodeURIComponent(user)
    + '&password=' + encodeURIComponent(pass)
    + '&scope=openid';

  try {
    var msg = new (Java.type('org.parosproxy.paros.network.HttpMessage'))();
    var reqHeader = new HttpRequestHeader(HttpRequestHeader.POST, new URI(tokenUrl, false), HttpHeader.HTTP11);
    reqHeader.setHeader(HttpHeader.CONTENT_TYPE, 'application/x-www-form-urlencoded');
    msg.setRequestHeader(reqHeader);
    msg.setRequestBody(form);
    msg.getRequestHeader().setContentLength(msg.getRequestBody().length());

    var sender = new HttpSender(HttpSender.MANUAL_REQUEST_INITIATOR);
    sender.sendAndReceive(msg, false);

    var status = msg.getResponseHeader().getStatusCode();
    if (status !== 200) {
      print('[bearer-auth] ERROR: token endpoint returned HTTP ' + status + ' (credentials/audience?).');
      return null;
    }
    var body = msg.getResponseBody().toString();
    var token = JSON.parse(body).access_token;
    var expiresIn = JSON.parse(body).expires_in || 300;
    // Refresh 30s before actual expiry to avoid mid-request expiration.
    cachedExpiryEpochMs = System.currentTimeMillis() + (expiresIn - 30) * 1000;
    return token;
  } catch (e) {
    print('[bearer-auth] ERROR: token mint failed: ' + e);
    return null;
  }
}

function getToken(forceRefresh) {
  if (forceRefresh || cachedToken === null || System.currentTimeMillis() >= cachedExpiryEpochMs) {
    cachedToken = mintToken();
  }
  return cachedToken;
}

// Called by ZAP before a request leaves the scanner.
function sendingRequest(msg, initiator, helper) {
  var host = msg.getRequestHeader().getHostName();
  if (!isBearerHost(host)) return;
  var token = getToken(false);
  if (token !== null) {
    msg.getRequestHeader().setHeader('Authorization', 'Bearer ' + token);
  }
}

// Called by ZAP after a response returns. A 401 from a bearer host means the token expired or was
// rejected — force a re-mint so the next request carries a fresh token (FR-013).
function responseReceived(msg, initiator, helper) {
  var host = msg.getRequestHeader().getHostName();
  if (!isBearerHost(host)) return;
  if (msg.getResponseHeader().getStatusCode() === 401) {
    getToken(true);
  }
}
