'use strict';

// Feature 087: the one route in the minimal `dist/server` that bff-server-trust-proxy.test.ts boots
// through the REAL `expo-server` adapter. It holds no app code: it reports the URL a route receives,
// which is what every route deriving a callback from `new URL(request.url).origin` depends on.
exports.GET = (request) => Response.json({ url: request.url });
