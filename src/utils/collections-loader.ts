/**
 * collections-loader.ts - Charge les collections depuis collections.json
 */

import { readFileSync } from "fs";
import { join } from "path";

export interface CollectionConfig {
  address: string;
  slug: string;
  name: string;
  enabled: boolean;
  maxCapitalEth: number;
}

/**
 * Charge toutes les collections depuis collections.json
 */
export function loadCollections(filePath?: string): CollectionConfig[] {
  const path = filePath || join(process.cwd(), "collections.json");

  try {
    const fileContent = readFileSync(path, "utf-8");
    const collections: CollectionConfig[] = JSON.parse(fileContent);

    return collections;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`❌ Failed to load collections from ${path}:`, msg);
    throw new Error(`Cannot load collections file: ${path}`);
  }
}

/**
 * Charge uniquement les collections activées (enabled: true)
 */
export function loadEnabledCollections(filePath?: string): CollectionConfig[] {
  const all = loadCollections(filePath);
  return all.filter(c => c.enabled);
}

/**
 * Trouve une collection par slug
 */
export function findCollectionBySlug(slug: string, filePath?: string): CollectionConfig | null {
  const collections = loadCollections(filePath);
  return collections.find(c => c.slug === slug) || null;
}

/**
 * Trouve une collection par address
 */
export function findCollectionByAddress(address: string, filePath?: string): CollectionConfig | null {
  const collections = loadCollections(filePath);
  return collections.find(c => c.address.toLowerCase() === address.toLowerCase()) || null;
}
