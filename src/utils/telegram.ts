import TelegramBot from 'node-telegram-bot-api';
import logger from './logger';

export class TelegramNotifier {
  private bot: TelegramBot;
  private chatId: string;

  constructor(token: string, chatId: string) {
    this.bot = new TelegramBot(token, { polling: false });
    this.chatId = chatId;
  }

  async send(message: string): Promise<void> {
    try {
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
      logger.info('Telegram notification sent');
    } catch (error) {
      logger.error('Failed to send Telegram notification', error);
    }
  }

  async sendOfferNotification(
    collection: string,
    apr: number,
    ltv: number,
    durationDays: number,
    amount: number
  ): Promise<void> {
    const message = `
<b>NEW OFFER</b> | ${this.shortenAddress(collection)}
APR ${(apr * 100).toFixed(1)}% | LTV ${(ltv * 100).toFixed(0)}%
${durationDays}d | ${amount.toFixed(2)} ETH
    `.trim();

    await this.send(message);
  }

  async sendErrorNotification(error: string): Promise<void> {
    const message = `<b>ERROR</b>\n${error}`;
    await this.send(message);
  }

  private shortenAddress(address: string): string {
    if (address.length <= 10) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}
