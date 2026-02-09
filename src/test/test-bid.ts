import "dotenv/config";
import { PriceFetcher } from "../collectors/price-fetcher";

const key = process.env.OPENSEA_API_KEY;
if (!key) { console.log("OPENSEA_API_KEY not set"); process.exit(1); }

const fetcher = new PriceFetcher({ openseaApiKey: key });

async function test() {
  const slugs = ["otherdeed", "pudgypenguins", "boredapeyachtclub", "azuki", "milady"];
  console.log("Collection".padEnd(28) + "Floor".padEnd(12) + "Bid".padEnd(12) + "Spread".padEnd(10) + "Status");
  console.log("-".repeat(75));
  for (const slug of slugs) {
    const p = await fetcher.fetchPrice(slug);
    const status = p.topBid > p.floorPrice ? "BID > FLOOR!" : p.topBid === 0 ? "NO BID" : "OK";
    console.log(
      slug.padEnd(28) +
      p.floorPrice.toFixed(4).padEnd(12) +
      p.topBid.toFixed(4).padEnd(12) +
      (p.spread.toFixed(1) + "%").padEnd(10) +
      status
    );
  }
}

test().catch(console.error);
