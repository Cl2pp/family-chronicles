import nodemailer from 'nodemailer';
import { env } from '@/lib/env';

/**
 * Minimal outbound email. First consumer is the book-order notification;
 * better-auth magic links can adopt this later. Without SMTP_URL the message
 * is logged instead of sent, so development and half-configured deploys never
 * fail on email — callers treat sending as best-effort.
 */

const transporter = env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : null;

export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
}): Promise<{ sent: boolean }> {
  if (!transporter) {
    console.log(
      `[email] SMTP_URL not set — would have sent to ${input.to}:\n` +
        `Subject: ${input.subject}\n${input.text}`,
    );
    return { sent: false };
  }
  await transporter.sendMail({
    from: env.SMTP_FROM,
    to: input.to,
    subject: input.subject,
    text: input.text,
  });
  return { sent: true };
}
