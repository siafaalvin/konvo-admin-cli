#!/usr/bin/env bun
/**
 * Standalone preview of the brand theme. Renders the wordmark + every
 * color helper + risk badges so you can eyeball the palette without
 * launching the interactive CLI.
 *
 * Usage:  bun run src/scripts/preview-theme.ts
 *
 * Not part of the CLI itself — pure dev/diagnostic tool.
 */

import { wordmark, tagline, divider, riskBadge, c, palette } from '../lib/theme.ts';

console.log('\n' + wordmark());
console.log(tagline() + '\n');

console.log(divider());
console.log(c.bold('Palette'));
console.log(divider());
for (const [name, hex] of Object.entries(palette)) {
  console.log(`  ${c.brand('●')}  ${name.padEnd(14)} ${c.dim(hex)}`);
}

console.log('\n' + divider());
console.log(c.bold('Color helpers'));
console.log(divider());
console.log(`  ${c.brand('brand text')}      orange #FF733E`);
console.log(`  ${c.body('body text')}       grey   #979AA3`);
console.log(`  ${c.white('white text')}      white  #FFFFFF`);
console.log(`  ${c.green('green text')}      ok     #2ECC71`);
console.log(`  ${c.yellow('yellow text')}     warn   #FFA557`);
console.log(`  ${c.red('red text')}        err    #FF4D4F`);
console.log(`  ${c.dim('dim text')}        muted body tone`);
console.log(`  ${c.bold('bold text')}       weight 700`);

console.log('\n' + divider());
console.log(c.bold('Risk badges'));
console.log(divider());
console.log(`  ${riskBadge('read-only')}  read-only   ${c.dim('inspections, no mutations')}`);
console.log(`  ${riskBadge('low')}  low         ${c.dim('reversible mutations')}`);
console.log(`  ${riskBadge('high')} high        ${c.dim('prod config / refunds / key rotation')}`);

console.log('\n' + divider() + '\n');
