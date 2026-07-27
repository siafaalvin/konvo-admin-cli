/**
 * Runbook — Send email template.
 *
 * Pick a pre-written template, fill in variables, send via Resend API
 * through the verification worker.
 */

import { psqlPiped, exec } from '../lib/ssh.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const runbook: Runbook = {
  id:          'send-email-template',
  title:       'Send email template',
  description: 'Send a pre-written email to a user (verification confirmed, GPS help, post removed, etc.).',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // Load available templates
    const templateDir = join(import.meta.dir, '..', 'templates');
    let files: string[];
    try {
      files = readdirSync(templateDir).filter(f => f.endsWith('.txt'));
    } catch {
      return { success: false, summary: 'Could not read templates directory.' };
    }

    if (files.length === 0) {
      return { success: false, summary: 'No templates found.' };
    }

    // Pick template
    const templateFile = await prompt.select({
      message: 'Which email template?',
      options: files.map(f => ({
        value: f,
        label: basename(f, '.txt').replace(/_/g, ' ')
      }))
    });
    if (typeof templateFile !== 'string') return { success: false, summary: 'Cancelled.' };

    // Read template
    const raw = readFileSync(join(templateDir, templateFile), 'utf-8');
    const [subjectLine, ...bodyParts] = raw.split('\n---\n');
    const subject = subjectLine.replace('Subject: ', '').trim();
    const bodyTemplate = bodyParts.join('\n---\n').trim();

    // Get recipient email
    const emailIn = await prompt.text({
      message: 'Recipient email:',
      validate: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v ?? '').trim()) ? undefined : 'Valid email required'
    });
    if (typeof emailIn !== 'string') return { success: false, summary: 'Cancelled.' };
    const email = (emailIn as string).trim().toLowerCase();

    // Get display name
    const sp = prompt.spinner();
    sp.start('Looking up user…');
    const lookup = await psqlPiped(ctx.config, `
      SELECT coalesce(p.display_name, uu.username, 'there') as name
      FROM auth.users au
      JOIN profiles p ON p.id = au.id
      LEFT JOIN user_usernames uu ON uu.user_id = au.id AND uu.is_primary = true
      WHERE lower(au.email) = lower('${email.replace(/'/g, "''")}')
      LIMIT 1;
    `, 'supabase_admin');
    sp.stop('Done.');

    const displayName = lookup.stdout.trim().split('\n').pop()?.trim() || 'there';

    // Fill in common variables
    let body = bodyTemplate
      .replace(/\{\{display_name\}\}/g, displayName)
      .replace(/\{\{email\}\}/g, email);

    // Check for remaining variables and prompt
    const remaining = body.match(/\{\{(\w+)\}\}/g) ?? [];
    for (const varMatch of [...new Set(remaining)]) {
      const varName = varMatch.replace(/\{\{|\}\}/g, '');
      const val = await prompt.text({ message: `Value for ${varName}:` });
      if (typeof val === 'string') {
        body = body.replace(new RegExp(`\\{\\{${varName}\\}\\}`, 'g'), val as string);
      }
    }

    // Preview
    prompt.note(`To: ${email}\nSubject: ${subject}\n\n${body}`, 'Preview');

    const confirmed = await prompt.confirm({ message: 'Send this email?', initialValue: true });
    if (!confirmed) return { success: false, summary: 'Not sent.' };

    if (ctx.dryRun) return { success: true, summary: `Dry-run: would send "${subject}" to ${email}` };

    // Send via worker (Resend)
    sp.start('Sending…');
    const sendResult = await exec(ctx.config, `curl -s -X POST https://worker.thekonvo.com/v1/notifications/dispatch -H 'Content-Type: application/json' -H "Authorization: Bearer $(docker exec konvo-worker-prod env | grep DISPATCH_SHARED_SECRET | cut -d= -f2)" -d '{"kind":"email_template","email":"${email}","subject":"${subject.replace(/'/g, "\\'")}","body":"${body.replace(/'/g, "\\'").replace(/\n/g, "\\n")}"}'`);
    sp.stop('Done.');

    // Note: if the worker doesn't handle email_template kind yet, fall back to direct Resend
    if (sendResult.stdout.includes('unknown kind')) {
      // Direct Resend via curl on VPS
      const resendResult = await exec(ctx.config, `curl -s -X POST https://api.resend.com/emails -H "Authorization: Bearer $(docker exec konvo-worker-prod env | grep RESEND_API_KEY | cut -d= -f2)" -H "Content-Type: application/json" -d '{"from":"Konvo <noreply@thekonvo.com>","to":["${email}"],"subject":"${subject.replace(/"/g, '\\"')}","text":"${body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"}'`);
      if (resendResult.stdout.includes('"id"')) {
        return { success: true, summary: `Sent "${subject}" to ${email} via Resend.` };
      } else {
        return { success: false, summary: `Send failed: ${resendResult.stdout.slice(0, 100)}` };
      }
    }

    return { success: true, summary: `Sent "${subject}" to ${email}.` };
  },
};

export default runbook;
