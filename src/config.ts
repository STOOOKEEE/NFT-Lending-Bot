import dotenv from 'dotenv';
import fs from 'fs/promises';
import { Config, CollectionConfig } from './types';
import logger from './utils/logger';

dotenv.config();

function getEnvVar(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvVarOptional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export function loadConfig(): Config {
  return {
    rpcUrl: getEnvVar('RPC_URL'),
    walletPrivateKey: getEnvVar('WALLET_PRIVATE_KEY'),
    openseaApiKey: getEnvVar('OPENSEA_API_KEY'),
    nftfiApiKey: getEnvVar('NFTFI_API_KEY'),
    telegramBotToken: getEnvVar('TELEGRAM_BOT_TOKEN'),
    telegramChatId: getEnvVar('TELEGRAM_CHAT_ID'),
    sendOffers: getEnvVarOptional('SEND_OFFERS', 'false') === 'true',
    maxCapitalEth: parseFloat(getEnvVarOptional('MAX_CAPITAL_ETH', '10')),
    collectionsFile: getEnvVarOptional('COLLECTIONS_FILE', './collections.json'),
    baseRate: parseFloat(getEnvVarOptional('BASE_RATE', '0.15')),
    riskFactor: parseFloat(getEnvVarOptional('RISK_FACTOR', '0.5')),
    maxLtv: parseFloat(getEnvVarOptional('MAX_LTV', '0.5')),
    minApr: parseFloat(getEnvVarOptional('MIN_APR', '0.1')),
    maxApr: parseFloat(getEnvVarOptional('MAX_APR', '2.0')),
    priceCollectionInterval: parseInt(getEnvVarOptional('PRICE_COLLECTION_INTERVAL', '15'), 10),
    marketCollectionInterval: parseInt(getEnvVarOptional('MARKET_COLLECTION_INTERVAL', '5'), 10),
  };
}

export async function loadCollections(filePath: string): Promise<CollectionConfig[]> {
  try {
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const collections: CollectionConfig[] = JSON.parse(fileContent);

    const enabledCollections = collections.filter(c => c.enabled);

    logger.info(`Loaded ${enabledCollections.length} enabled collections from ${filePath}`);
    return enabledCollections;
  } catch (error) {
    logger.error(`Failed to load collections from ${filePath}`, error);
    throw new Error(`Cannot load collections file: ${filePath}`);
  }
}
