/**
 * Apply an alpha channel to a theme colour token.
 *
 * Exists because the naive form — `theme.onSurface?.val + '14'` — is wrong in two ways that
 * both fail silently. It assumes the token is a 6-digit hex (a `rgb()`, `hsl()` or named value
 * yields an invalid colour string, which React Native and the browser both drop, rendering
 * NOTHING rather than erroring), and an 8% state layer over a dark surface is effectively
 * invisible even when the concatenation happens to be valid. Measured on feature 062: the
 * secondary tab row's hover state could not be seen at all in dark mode.
 *
 * Returns `rgba(...)`, which every target accepts regardless of the input notation.
 */

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function hexToRgb(hex: string): [number, number, number] | null {
  const match = HEX.exec(hex.trim());
  if (!match) return null;
  let body = match[1];
  if (body.length === 3) body = body.split('').map((c) => c + c).join('');
  return [
    parseInt(body.slice(0, 2), 16),
    parseInt(body.slice(2, 4), 16),
    parseInt(body.slice(4, 6), 16),
  ];
}

/**
 * `withAlpha('#E3E2E6', 0.12)` → `'rgba(227, 226, 230, 0.12)'`.
 *
 * A non-hex input is returned unchanged rather than corrupted: an `rgba()` token already
 * carries its own alpha, and silently producing an invalid string is the failure this helper
 * exists to prevent. `alpha` is clamped to 0–1.
 */
export function withAlpha(color: string | undefined, alpha: number): string | undefined {
  if (!color) return undefined;
  const rgb = hexToRgb(color);
  if (!rgb) return color;
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

/**
 * MD3 state-layer opacities. Named rather than inlined so a hover and a press cannot drift
 * apart between components, and so the dark-mode values are a deliberate choice in one place:
 * a state layer that reads clearly on `surface` at 8% in light mode does not on `#0F1117`.
 */
export const stateLayer = {
  hover: 0.12,
  focus: 0.14,
  press: 0.18,
} as const;
