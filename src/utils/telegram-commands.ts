/**
 * telegram-commands.ts - Telegram command handler for risk management
 *
 * Uses getUpdates long-polling to listen for commands.
 * Commands:
 *   /status   - Portfolio stats
 *   /limits   - Show all limits
 *   /setlimit <collection> <amount> - Per-collection limit
 *   /setmax <amount> - Global max capital
 *   /loans    - Active loans
 *   /risk     - Risk alerts
 *   /help     - Available commands
 */

import { RiskManager } from "../risk/RiskManager";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

/** Track last processed update to avoid duplicates */
let lastUpdateId = 0;

/** Polling interval (seconds) */
const POLL_INTERVAL = 5;

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
}

interface TelegramResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

async function sendReply(text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[TelegramCmd] Send error:", msg);
  }
}

function handleStatus(rm: RiskManager): string {
  const stats = rm.getPortfolioStats();
  return [
    "<b>📊 PORTFOLIO STATUS</b>",
    "",
    `💰 Capital: ${stats.deployedCapital.toFixed(2)}/${stats.totalCapital.toFixed(2)} ETH`,
    `📈 Utilization: ${(stats.utilizationRate * 100).toFixed(1)}%`,
    `📋 Active loans: ${stats.activeLoans}`,
    `💵 Avg APR: ${(stats.averageAPR * 100).toFixed(2)}%`,
    `📉 At risk: ${stats.atRiskCapital.toFixed(2)} ETH`,
    `🔮 Expected return: ${stats.totalExpectedReturn.toFixed(4)} ETH`,
    "",
    ...Object.entries(stats.totalExposure).map(([col, exp]) =>
      `  ${col}: ${exp.toFixed(2)} ETH`
    ),
  ].join("\n");
}

function handleLimits(rm: RiskManager): string {
  const limits = rm.getLimits();
  const colLimits = rm.getCollectionLimits();

  const lines = [
    "<b>🛡️ RISK LIMITS</b>",
    "",
    `Max capital: ${limits.maxCapitalEth} ETH`,
    `Max per collection: ${limits.maxExposurePerCollection} ETH`,
    `Max loans/collection: ${limits.maxLoansPerCollection}`,
    `Max active loans: ${limits.maxActiveLoan}`,
    `Max utilization: ${(limits.maxUtilizationRate * 100).toFixed(0)}%`,
    `Min reserve: ${(limits.minReserveRatio * 100).toFixed(0)}%`,
    `Liquidation threshold: ${(limits.liquidationRiskThreshold * 100).toFixed(0)}%`,
  ];

  if (colLimits.size > 0) {
    lines.push("", "<b>Per-collection overrides:</b>");
    for (const [slug, max] of colLimits.entries()) {
      lines.push(`  ${slug}: ${max} ETH`);
    }
  }

  return lines.join("\n");
}

function handleSetLimit(rm: RiskManager, args: string[]): string {
  if (args.length < 2) {
    return "Usage: /setlimit &lt;collection&gt; &lt;amount_eth&gt;";
  }

  const slug = args[0];
  const amount = parseFloat(args[1]);

  if (isNaN(amount) || amount <= 0) {
    return `Invalid amount: ${args[1]}`;
  }

  rm.setCollectionLimit(slug, amount);
  return `✅ Set ${slug} max exposure to ${amount} ETH`;
}

function handleSetMax(rm: RiskManager, args: string[]): string {
  if (args.length < 1) {
    return "Usage: /setmax &lt;amount_eth&gt;";
  }

  const amount = parseFloat(args[0]);

  if (isNaN(amount) || amount <= 0) {
    return `Invalid amount: ${args[0]}`;
  }

  rm.updateLimits({ maxCapitalEth: amount });
  return `✅ Set max capital to ${amount} ETH`;
}

function handleLoans(rm: RiskManager): string {
  const loans = rm.getActiveLoans();

  if (loans.length === 0) {
    return "📋 No active loans";
  }

  const lines = [`<b>📋 ACTIVE LOANS (${loans.length})</b>`, ""];

  for (const loan of loans) {
    const risk = loan.liquidationRisk > 0.5 ? "🔴" : loan.liquidationRisk > 0.2 ? "🟡" : "🟢";
    const floor = loan.currentFloorPrice ? `floor ${loan.currentFloorPrice.toFixed(3)}` : "no price";
    lines.push(
      `${risk} ${loan.collection} | ${loan.loanAmount.toFixed(3)} ETH @ ${(loan.apr * 100).toFixed(1)}% | ${floor}`
    );
  }

  return lines.join("\n");
}

function handleRisk(rm: RiskManager): string {
  const alerts = rm.getRiskAlerts();

  if (alerts.length === 0) {
    return "✅ No risk alerts";
  }

  return `<b>🚨 RISK ALERTS</b>\n\n${alerts.join("\n")}`;
}

function handleHelp(): string {
  return [
    "<b>🤖 NFT LENDING BOT</b>",
    "",
    "/status - Portfolio stats",
    "/limits - Show risk limits",
    "/setlimit &lt;col&gt; &lt;eth&gt; - Set collection limit",
    "/setmax &lt;eth&gt; - Set max capital",
    "/loans - Active loans",
    "/risk - Risk alerts",
    "/help - This message",
  ].join("\n");
}

async function processCommand(text: string, rm: RiskManager): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  let reply: string;

  switch (command) {
    case "/status":
      reply = handleStatus(rm);
      break;
    case "/limits":
      reply = handleLimits(rm);
      break;
    case "/setlimit":
      reply = handleSetLimit(rm, args);
      break;
    case "/setmax":
      reply = handleSetMax(rm, args);
      break;
    case "/loans":
      reply = handleLoans(rm);
      break;
    case "/risk":
      reply = handleRisk(rm);
      break;
    case "/help":
    case "/start":
      reply = handleHelp();
      break;
    default:
      return; // Ignore unknown commands
  }

  await sendReply(reply);
}

async function pollUpdates(rm: RiskManager): Promise<void> {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=${POLL_INTERVAL}`;
    const res = await fetch(url);
    if (!res.ok) return;

    const data = (await res.json()) as TelegramResponse;
    if (!data.ok || !data.result) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;

      const msg = update.message;
      if (!msg || !msg.text) continue;

      // Only respond to messages from our chat
      if (String(msg.chat.id) !== CHAT_ID) continue;

      // Only process commands (starts with /)
      if (!msg.text.startsWith("/")) continue;

      await processCommand(msg.text, rm);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[TelegramCmd] Poll error:", msg);
  }
}

/**
 * Start Telegram command polling loop.
 * Runs forever in the background (non-blocking).
 */
export function startTelegramCommands(rm: RiskManager): void {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("[TelegramCmd] Disabled (no TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)");
    return;
  }

  console.log("[TelegramCmd] Starting command listener...");

  // Poll every POLL_INTERVAL seconds
  const poll = () => {
    pollUpdates(rm).finally(() => {
      setTimeout(poll, POLL_INTERVAL * 1000);
    });
  };

  // Start polling
  poll();
}
