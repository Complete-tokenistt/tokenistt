/**
 * services/notify.ts — outbound notifications (Slack-compatible webhook + SMTP email).
 * Best-effort: failures are logged and swallowed so they can never break a request.
 */
import axios from 'axios';

export interface Notification {
  title: string;
  text: string;
  fields?: Record<string, string>;
  severity?: 'info' | 'warn' | 'critical';
}

const COLORS = { info: '#3182CE', warn: '#DD6B20', critical: '#E53E3E' } as const;

export async function sendWebhook(url: string, n: Notification): Promise<boolean> {
  try {
    await axios.post(
      url,
      {
        text: `*${n.title}*\n${n.text}`,
        attachments: [
          {
            color: COLORS[n.severity ?? 'info'],
            fields: Object.entries(n.fields ?? {}).map(([title, value]) => ({ title, value, short: true })),
          },
        ],
      },
      { timeout: 5000 }
    );
    return true;
  } catch (err: any) {
    console.error('[Notify] webhook failed:', err.message);
    return false;
  }
}

/** Email via SMTP when SMTP_URL (e.g. smtp://user:pass@host:587) and ALERT_EMAIL_TO are set. */
export async function sendEmail(n: Notification): Promise<boolean> {
  const smtp = process.env.SMTP_URL;
  const to = process.env.ALERT_EMAIL_TO;
  if (!smtp || !to) return false;
  try {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport(smtp);
    const body = [n.text, '', ...Object.entries(n.fields ?? {}).map(([k, v]) => `${k}: ${v}`)].join('\n');
    await transport.sendMail({
      from: process.env.ALERT_EMAIL_FROM || 'tokenistt@localhost',
      to,
      subject: `[Tokenistt] ${n.title}`,
      text: body,
    });
    return true;
  } catch (err: any) {
    console.error('[Notify] email failed:', err.message);
    return false;
  }
}

/** Fan out to every configured channel. Returns the channels that succeeded. */
export async function notifyAll(n: Notification): Promise<string[]> {
  const sent: string[] = [];
  const hook = process.env.SLACK_WEBHOOK_URL || process.env.BUDGET_ALERT_WEBHOOK_URL;
  if (hook && (await sendWebhook(hook, n))) sent.push('webhook');
  if (await sendEmail(n)) sent.push('email');
  return sent;
}
