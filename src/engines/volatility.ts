/**
 * volatility.ts - Calculs de volatilité pour Black-Scholes
 */

import { getDailyAveragePrices } from "../utils/price-db";

// ==================== TYPES ====================

export interface DailyPrice {
  date: string;
  price: number;
}

export interface VolatilityResult {
  daily: number;
  ewma: number;
  rolling30d: number;
  annualized: number;
}

// ==================== CALCULS ====================

export function calculateDailyReturns(prices: DailyPrice[]): number[] {
  const returns: number[] = [];
  
  for (let i = 1; i < prices.length; i++) {
    const prevPrice = prices[i - 1].price;
    const currPrice = prices[i].price;
    
    if (prevPrice > 0) {
      const dailyReturn = (currPrice - prevPrice) / prevPrice;
      returns.push(dailyReturn);
    }
  }
  
  return returns;
}

export function calculateStdVolatility(prices: DailyPrice[]): number {
  const returns = calculateDailyReturns(prices);
  
  if (returns.length < 2) {
    return 0;
  }
  
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  
  return Math.sqrt(variance);
}

export function calculateEWMAVolatility(prices: DailyPrice[], lambda?: number): number {
  const returns = calculateDailyReturns(prices);
  
  if (returns.length < 2) {
    return 0;
  }
  
  if (lambda === undefined) {
    lambda = findOptimalLambda(returns);
  }
  
  let variance = 0;
  
  for (const r of returns) {
    variance = lambda * variance + (1 - lambda) * r * r;
  }
  
  return Math.sqrt(variance);
}

export function findOptimalLambda(returns: number[]): number {
  if (returns.length < 10) {
    return 0.94;
  }
  
  let optimalLambda = 0.94;
  let minMSE = Number.MAX_SAFE_INTEGER;
  
  for (let i = 80; i <= 99; i++) {
    const lambda = i / 100;
    let variance = 0;
    let mse = 0;
    
    for (let j = 1; j < returns.length; j++) {
      const r = returns[j];
      const prevVariance = variance;
      variance = lambda * variance + (1 - lambda) * r * r;
      
      const forecastError = r * r - prevVariance;
      mse += forecastError * forecastError;
    }
    
    mse /= returns.length - 1;
    
    if (mse < minMSE) {
      minMSE = mse;
      optimalLambda = lambda;
    }
  }
  
  return optimalLambda;
}

export function calculateRollingVolatility(prices: DailyPrice[], windowDays = 30): number {
  if (prices.length < windowDays) {
    return calculateStdVolatility(prices);
  }
  
  const recentPrices = prices.slice(-windowDays);
  return calculateStdVolatility(recentPrices);
}

export function annualizeVolatility(dailyVol: number): number {
  return dailyVol * Math.sqrt(365);
}

export function calculateAllVolatilities(prices: DailyPrice[]): VolatilityResult {
  const cleanPrices = removeOutliers(prices);
  
  if (cleanPrices.length < 2) {
    return {
      daily: 0,
      ewma: 0,
      rolling30d: 0,
      annualized: 0,
    };
  }
  
  const daily = calculateStdVolatility(cleanPrices);
  const ewma = calculateEWMAVolatility(cleanPrices);
  const rolling30d = calculateRollingVolatility(cleanPrices, 30);
  
  return {
    daily,
    ewma,
    rolling30d,
    annualized: annualizeVolatility(daily),
  };
}

export function removeOutliers(prices: DailyPrice[], threshold = 2): DailyPrice[] {
  if (prices.length < 3) return prices;
  
  const priceValues = prices.map(p => p.price);
  const mean = priceValues.reduce((a, b) => a + b, 0) / priceValues.length;
  const variance = priceValues.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / priceValues.length;
  const stdDev = Math.sqrt(variance);
  
  return prices.filter(p => {
    const zScore = Math.abs((p.price - mean) / stdDev);
    return zScore < threshold;
  });
}

// ==================== CALCUL DEPUIS SUPABASE ====================

export async function calculateVolatilityFromDb(
  collectionSlug: string,
  days: number = 30
): Promise<VolatilityResult> {
  try {
    const dailyData = await getDailyAveragePrices(collectionSlug, days);
    
    if (dailyData.length < 3) {
      console.warn(`⚠️ Not enough data for ${collectionSlug} (only ${dailyData.length} days)`);
      return {
        daily: 0,
        ewma: 0,
        rolling30d: 0,
        annualized: 0,
      };
    }
    
    const prices: DailyPrice[] = dailyData.map(d => ({
      date: d.date,
      price: d.avg_mid,
    }));
    
    return calculateAllVolatilities(prices);
  } catch (error: any) {
    console.error(`❌ Error calculating volatility for ${collectionSlug}:`, error.message);
    return {
      daily: 0,
      ewma: 0,
      rolling30d: 0,
      annualized: 0,
    };
  }
}

export async function calculateVolatilitiesFromDb(
  collectionSlugs: string[],
  days: number = 30
): Promise<Map<string, VolatilityResult>> {
  const results = new Map<string, VolatilityResult>();
  
  for (const slug of collectionSlugs) {
    const vol = await calculateVolatilityFromDb(slug, days);
    results.set(slug, vol);
  }
  
  return results;
}
