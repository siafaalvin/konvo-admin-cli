/**
 * Konvo brand theme for the CLI. Mirrors the PWA's Aurora theme:
 *   brand orange  #FF733E   primary accent (CTA, highlights)
 *   navy          #010B28   page bg
 *   navy elevated #061029   raised surface
 *   navy soft     #0E2248   inputs, raised
 *   white         #FFFFFF   primary text
 *   body          #979AA3   secondary text
 *
 * Uses `chalk` (true-color hex support) + `figlet` (ASCII wordmark) +
 * `gradient-string` (orange-to-white gradient on the wordmark).
 *
 * Single export: applyBrand(token, str) — wraps a string in the right
 * color. Plus `wordmark()` for the boot intro and `tagline()` for
 * subtitle copy.
 */

import chalk from 'chalk';
import figlet from 'figlet';
import gradient from 'gradient-string';

// ─── Palette ───────────────────────────────────────────────────────────
export const palette = {
  brand:        '#FF733E',
  brandSoft:    '#FFA57A',  // brand-300
  navy:         '#010B28',
  navyElevated: '#061029',
  navySoft:     '#0E2248',
  white:        '#FFFFFF',
  body:         '#979AA3',
  green:        '#2ECC71',
  red:          '#FF4D4F',
  yellow:       '#FFA557'
} as const;

export type ThemeToken = keyof typeof palette;

// ─── Color helpers ─────────────────────────────────────────────────────
export const c = {
  brand:    (s: string): string => chalk.hex(palette.brand)(s),
  body:     (s: string): string => chalk.hex(palette.body)(s),
  white:    (s: string): string => chalk.hex(palette.white)(s),
  green:    (s: string): string => chalk.hex(palette.green)(s),
  red:      (s: string): string => chalk.hex(palette.red)(s),
  yellow:   (s: string): string => chalk.hex(palette.yellow)(s),
  dim:      (s: string): string => chalk.hex(palette.body).dim(s),
  bold:     (s: string): string => chalk.bold(s)
};

// ─── Konvo wordmark for the boot intro ─────────────────────────────────
// Gradient from brand orange → brandSoft → white. Reads as warm
// accent fading into the brightest tone — high contrast in any
// terminal background.
const brandGradient = gradient(palette.brand, palette.brandSoft, palette.white);

/** Returns a multi-line ASCII wordmark with brand gradient applied. */
export function wordmark(): string {
  const ascii = figlet.textSync('konvo', {
    font:             'Slant',
    horizontalLayout: 'fitted',
    verticalLayout:   'default'
  });
  return brandGradient.multiline(ascii);
}

/** Subtitle line under the wordmark — short, dim, body-tone. */
export function tagline(version: string = '0.1.0'): string {
  return c.dim(`admin-cli v${version}  ·  operator runbooks`);
}

/** Section divider — soft brand line. */
export function divider(): string {
  return c.dim('─'.repeat(48));
}

/**
 * Status badge — tiny colored pill for risk levels in the menu.
 * Matches the symbolic prefix used in src/index.ts ('·' / '!' / '!!').
 */
export function riskBadge(risk: 'read-only' | 'low' | 'high'): string {
  switch (risk) {
    case 'read-only': return c.dim('·');
    case 'low':       return c.yellow('!');
    case 'high':      return c.red('!!');
  }
}
