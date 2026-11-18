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

function totalPrice(card) {
  const money = parseMoney(card?.priceText);
  const value = Number(money?.value);
  return money && Number.isFinite(value) ? value : NaN;
}

// Recommendations rank by the rounded daily rate, so the stop compares rounded daily rates;
// the order check uses the unrounded rental total, which rounding cannot hide.
function createPriceLeaderGate({ durationDays, competitorCount = 3 }) {
  const state = { ordered: true, ownSeen: false, ownDaily: null, competitors: [], cutoff: null,
    stopped: false, lastTotal: -Infinity, lastDaily: -Infinity, totalCount: null };
  const seen = new Set();
  let checked = 0;
  return {
    state,
    shouldStop(cards) {
      for (; checked < cards.length; checked += 1) {
        const card = cards[checked];
        const total = totalPrice(card);
        const provider = normalizeProvider(card?.provider).toLowerCase();
        if (!Number.isFinite(total) || total < state.lastTotal || !provider || !(durationDays > 0)) {
          state.ordered = false;
          continue;
        }
        state.lastTotal = total;
        state.lastDaily = Number((total / durationDays).toFixed(2));
        if (isOwnProvider(provider)) {
          if (!state.ownSeen) state.ownDaily = state.lastDaily;
          state.ownSeen = true;
        } else if (!seen.has(provider)) {
          seen.add(provider);
          if (state.competitors.length < competitorCount) state.competitors.push({ provider, price: state.lastDaily });
        }
      }
      if (!state.ordered || state.competitors.length < competitorCount) return false;
      state.cutoff = state.competitors[competitorCount - 1].price;
      // A later offer at MM Cars Rental's daily rate would tie it and could change its rank.
      state.stopped = state.lastDaily > state.cutoff && (!state.ownSeen || state.lastDaily > state.ownDaily);
      return state.stopped;
    }
  };
}

module.exports = { PRICE_SORT, OWN_SUPPLIER_ID, OWN_FILTER_SOURCE, createPriceLeaderGate, isOwnProvider,
  normalizeProvider, totalPrice };
