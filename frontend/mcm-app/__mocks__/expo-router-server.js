/**
 * Manual mock for expo-router/server
 * Used in BFF API route unit tests.
 */

const ExpoResponse = {
  json(data, init) {
    const status = (init && init.status) != null ? init.status : 200;
    const headersInit = (init && init.headers) ? init.headers : {};
    const headers = new Headers(headersInit);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers,
      json: () => Promise.resolve(data),
    };
  },
};

class ExpoRequest {}

module.exports = { ExpoRequest, ExpoResponse };
