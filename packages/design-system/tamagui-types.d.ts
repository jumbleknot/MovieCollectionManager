// Tamagui type augmentation for the MCM design system (feature 015).
// Kept in a separate ambient declaration file (not tamagui.config.ts) to avoid the
// createTamagui ↔ TamaguiCustomConfig ↔ typeof config self-reference (TS7022/2456/2310).
// Pulled into consumers via a triple-slash reference at the top of index.ts.
import type { AppConfig } from './tamagui.config';

declare module 'tamagui' {
  interface TamaguiCustomConfig extends AppConfig {}
}
