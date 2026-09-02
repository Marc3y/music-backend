import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.EMAIL_FROM as string;

export async function sendVerificationEmail(email: string, code: string): Promise<void> {
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Dein Bestätigungscode",
    html: `<p>Dein Bestätigungscode lautet: <strong>${code}</strong></p><p>Gültig für 15 Minuten.</p>`,
  });
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Passwort zurücksetzen",
    html: `<p>Klick <a href="${resetUrl}">hier</a>, um dein Passwort zurückzusetzen.</p><p>Gültig für 30 Minuten.</p>`,
  });
}

export async function sendPasswordChangeCodeEmail(email: string, code: string): Promise<void> {
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Passwortänderung bestätigen",
    html: `<p>Du hast eine Passwortänderung angefordert.</p><p>Dein Bestätigungscode lautet: <strong>${code}</strong></p><p>Gültig für 15 Minuten. Falls du das nicht warst, ignoriere diese E-Mail – dein Passwort bleibt unverändert.</p>`,
  });
}

export async function sendAccountDeletionCodeEmail(email: string, code: string): Promise<void> {
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Account-Löschung bestätigen",
    html: `<p>Du hast die Löschung deines Accounts angefordert.</p><p>Dein Bestätigungscode lautet: <strong>${code}</strong></p><p>Gültig für 15 Minuten. <strong>Diese Aktion ist endgültig</strong> – alle deine Playlists, Tracks und Bilder werden unwiderruflich gelöscht. Falls du das nicht warst, ignoriere diese E-Mail.</p>`,
  });
}