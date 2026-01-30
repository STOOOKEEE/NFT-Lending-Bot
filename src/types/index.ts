export type PriceSource = 'opensea';
export type LendingPlatform = 'blur' | 'nftfi' | 'gondi';

export interface PriceData {
  collection: string;
  floorPrice: number;
  timestamp: number;
  source: PriceSource;
  topBid?: number;
}

export interface LoanOffer {
  platform: LendingPlatform;
  collection: string;
  apr: number;
  ltv: number;
  durationDays: number;
  amount: number;
}

export interface PricingParams {
  baseRate: number;
  riskFactor: number;
  maxLtv: number;
  minApr: number;
  maxApr: number;
}

export interface StrategyConfig {
  maxCapitalPerCollection: number;
  targetCollections: string[];
  competitiveMargin: number;
  collectionCapitalMap?: Map<string, number>;
}

export interface CollectionConfig {
  address: string;
  name: string;
  symbol: string;
  enabled: boolean;
  maxCapitalEth: number;
}

export interface Config {
  rpcUrl: string;
  walletPrivateKey: string;
  openseaApiKey: string;
  nftfiApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  sendOffers: boolean;
  maxCapitalEth: number;
  collectionsFile: string;
  baseRate: number;
  riskFactor: number;
  maxLtv: number;
  minApr: number;
  maxApr: number;
  priceCollectionInterval: number;
  marketCollectionInterval: number;
}

export interface VolatilityResult {
  collection: string;
  volatility: number;
  timestamp: number;
}
