import { Platform } from 'react-native';

// Web uses relative URLs (same origin — Expo dev server or Docker container).
// Native needs an absolute URL to reach the BFF over the network.
//   - Local dev (expo start): EXPO_PUBLIC_BFF_NATIVE_URL=http://10.0.2.2:8081 in .env.local
//   - EAS builds: EXPO_PUBLIC_BFF_BASE_URL=http://10.0.2.2:8081 set in eas.json (used as fallback)
export const BFF_BASE_URL: string =
  Platform.OS === 'web'
    ? ''
    : (process.env['EXPO_PUBLIC_BFF_NATIVE_URL'] ??
       process.env['EXPO_PUBLIC_BFF_BASE_URL'] ??
       'http://10.0.2.2:8081');
