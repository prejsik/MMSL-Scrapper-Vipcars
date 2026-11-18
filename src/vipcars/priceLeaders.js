const { normalizeWhitespace, parseMoney } = require("./utils");

// VipCars lists automatic offers cheapest first (sort_by=2). Pricing needs only MM Cars Rental's
// cheapest offer and the three cheapest competitors, so pagination may stop once three distinct
// competitors are known and a strictly more expensive offer proves no later offer can tie or beat
// the third. Any offer that breaks the price order, or has no readable price, keeps full pagination.
const PRICE_SORT = "2";
const OWN_SUPPLIER_ID = "mm_cars_rental";
const OWN_FILTER_SOURCE = "search_own_filter";

const PROVIDER_ALIASES = [
  [/^EuropCar$/i, "Europcar"],
  [/^Surprice Car Rental$/i, "SurPrice"],
  [/^Green motion$/i, "Green Motion"],
  [/^Ace$/i, "Ace Rent a Car"]
];

function normalizeProvider(value) {
  return PROVIDER_ALIASES.reduce((name, [pattern, replacement]) => name.replace(pattern, replacement),
    normalizeWhitespace(value));
}

function isOwnProvider(value) {
  return normalizeWhitespace(value).toLowerCase().includes("mm cars rental");
}

function dailyPrice(card, durationDays) {
  const money = parseMoney(card?.priceText);
  if (!money || !Number.isFinite(Number(money.value)) || !(durationDays > 0)) return NaN;
  return Number((Number(money.value) / durationDays).toFixed(2));
}

function createPriceLeaderGate({ durationDays, competitorCount = 3 }) {
  const state = { ordered: true, ownSeen: false, competitors: [], cutoff: null, stopped: false };
  const seen = new Set();
  let checked = 0;
  let lastPrice = -Infinity;
  return {
    state,
    shouldStop(cards) {
      for (; checked < cards.length; checked += 1) {
        const card = cards[checked];
        const price = dailyPrice(card, durationDays);
        const provider = normalizeProvider(card?.provider).toLowerCase();
        if (!Number.isFinite(price) || price < lastPrice || !provider) {
          state.ordered = false;
          continue;
        }
        lastPrice = price;
        if (isOwnProvider(provider)) {
          state.ownSeen = true;
        } else if (!seen.has(provider)) {
          seen.add(provider);
          if (state.competitors.length < competitorCount) state.competitors.push({ provider, price });
        }
      }
      if (!state.ordered || state.competitors.length < competitorCount) return false;
      state.cutoff = state.competitors[competitorCount - 1].price;
      state.stopped = lastPrice > state.cutoff;
      return state.stopped;
    }
  };
}

module.exports = { PRICE_SORT, OWN_SUPPLIER_ID, OWN_FILTER_SOURCE, createPriceLeaderGate, isOwnProvider, normalizeProvider };
