-- Performance indexes for NFT Lending Bot
-- Run on Supabase SQL Editor

-- price_history: used by getLatestFloorPrice, getPriceHistory, compaction
CREATE INDEX IF NOT EXISTS idx_price_history_collection_ts
  ON price_history(collection_slug, timestamp DESC);

-- lending_offers: used by trackOffers (getOffersByLender)
CREATE INDEX IF NOT EXISTS idx_lending_offers_lender_status
  ON lending_offers(lender_address, marketplace, status);

-- lending_offers: used by markExpiredOffers
CREATE INDEX IF NOT EXISTS idx_lending_offers_expiration
  ON lending_offers(status, expiration_time)
  WHERE status = 'ACTIVE';

-- lending_offers: used by hasActiveOffer
CREATE INDEX IF NOT EXISTS idx_lending_offers_collection_active
  ON lending_offers(collection_address, status, expiration_time)
  WHERE status = 'ACTIVE';
