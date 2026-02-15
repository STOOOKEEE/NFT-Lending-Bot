/**
 * telegram.ts - Utilitaires pour envoyer des messages Telegram
 */

const TELEGRAM_ENABLED = !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID;

/**
 * Envoie un message Telegram
 */
export async function sendTelegramMessage(message: string): Promise<void> {
  if (!TELEGRAM_ENABLED) return;

  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN!;
    const chatId = process.env.TELEGRAM_CHAT_ID!;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      }),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[Telegram] Error sending message:", msg);
  }
}

/**
 * Envoie une alerte rate limit OpenSea
 */
export async function sendRateLimitAlert(
  collectionSlug: string,
  retryAfterSeconds: number
): Promise<void> {
  const message = `
⚠️ <b>OpenSea Rate Limit</b>

Collection: <code>${collectionSlug}</code>
Retry in: ${retryAfterSeconds}s
  `.trim();

  await sendTelegramMessage(message);
}
