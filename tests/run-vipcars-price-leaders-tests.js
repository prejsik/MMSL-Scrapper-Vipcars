const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { createPriceLeaderGate } = require("../src/vipcars/priceLeaders");
const { collectResultPages, parseResultRequest } = require("../src/vipcars/resultTransport");
const { VipCarsScraper } = require("../src/vipcars/scraper");
const { buildRecommendations } = require("../src/vipcars/pricingRecommendations");

const offer = (id, provider, total) => ({ cardId: id, provider, priceText: `EUR ${total.toFixed(2)}` });
const gate = () => createPriceLeaderGate({ durationDays: 2 });

function testGateStopsOnlyAfterThreeCompetitorsAndAStrictlyHigherPrice() {
  const leaders = gate();
  assert.equal(leaders.shouldStop([offer("1", "A", 10), offer("2", "A", 11), offer("3", "B", 12)]), false);
  assert.equal(leaders.shouldStop([offer("1", "A", 10), offer("2", "A", 11), offer("3", "B", 12), offer("4", "C", 13)]), false,
    "a later offer at the third competitor's price could still tie it");
  assert.equal(leaders.shouldStop([offer("1", "A", 10), offer("2", "A", 11), offer("3", "B", 12), offer("4", "C", 13),
    offer("5", "D", 13), offer("6", "C", 15)]), true);
  assert.deepEqual(leaders.state.competitors.map((item) => item.provider), ["a", "b", "c"]);
  assert.equal(leaders.state.ownSeen, false);
  console.log("PASS price leaders stop only after three competitors and a strictly higher price");
}

function testOwnOffersAreNotCompetitorsAndAliasesAreOneProvider() {
  const leaders = gate();
  const cards = [offer("1", "Ace", 10), offer("2", "Ace Rent a Car", 11), offer("3", "MM Cars Rental", 12),
    offer("4", "B", 13), offer("5", "C", 14), offer("6", "D", 15)];
  assert.equal(leaders.shouldStop(cards), true);
  assert.equal(leaders.state.ownSeen, true);
  assert.deepEqual(leaders.state.competitors.map((item) => item.provider), ["ace rent a car", "b", "c"]);
  console.log("PASS own offers are not competitors and provider aliases count once");
}

function testBrokenOrderOrUnreadablePriceDisablesEarlyStop() {
  const unsorted = gate();
  assert.equal(unsorted.shouldStop([offer("1", "A", 10), offer("2", "B", 9), offer("3", "C", 12), offer("4", "D", 13)]), false);
  assert.equal(unsorted.state.ordered, false);
  assert.equal(unsorted.shouldStop([offer("1", "A", 10), offer("2", "B", 9), offer("3", "C", 12), offer("4", "D", 13),
    offer("5", "E", 20)]), false, "order evidence is permanent for the search");
  const unreadable = gate();
  assert.equal(unreadable.shouldStop([offer("1", "A", 10), { cardId: "2", provider: "B", priceText: "on request" },
    offer("3", "C", 12), offer("4", "D", 13), offer("5", "E", 20)]), false);
  assert.equal(unreadable.state.ordered, false);
  console.log("PASS broken price order or an unreadable price disables early stop");
}

async function testPaginationStopsWithoutFetchingLaterPages() {
  const pages = {
    2: { cards: [offer("3", "B", 12), offer("4", "C", 13)], totalCount: 8, nextOffset: 4, nextPage: 2 },
    4: { cards: [offer("5", "D", 14), offer("6", "C", 15)], totalCount: 8, nextOffset: 6, nextPage: 3 }
  };
  const requested = [];
  const leaders = gate();
  const cards = await collectResultPages({
    initial: { cards: [offer("1", "A", 10), offer("2", "A", 11)], totalCount: 8, nextOffset: 2, nextPage: 1 },
    source: { url: "https://be.supplycars.com/be1/node.php?%22&offset=0&car_page=0%22" },
    deadlineAt: Date.now() + 10000,
    stopWhen: leaders.shouldStop,
    fetchPage: async (url) => {
      const offset = Number(new URL(url).search.match(/offset=(\d+)/)[1]);
      requested.push(offset);
      return pages[offset];
    }
  });
  assert.deepEqual(requested, [2, 4]);
  assert.equal(cards.length, 6);
  console.log("PASS pagination stops at the price leaders without fetching later pages");
}

function card(id, provider, price) {
  return `<article class="scv-car-box" id="${id}">
    <div class="scv-supp-info"><img alt="${provider}"></div>
    <div class="scv-car-name">Fixture car</div><div class="scv-car-cat">Economy</div>
    <div class="scv-new-amount">EUR ${price.toFixed(2)}</div><div class="scv-pay-now">Pay Now EUR ${(price / 10).toFixed(2)}</div>
    <ul class="scv-car-specs"><li><i class="scv-icon autom"></i>Automatic transmission</li></ul>
  </article>`;
}

function pageHtml(cards, nextOffset, nextPage, total) {
  return cards.join("") + `<script>$("#offset").val(${nextOffset});$("#car_page").val(${nextPage});
    $("#car_count_data").val(${total});</script>`;
}

function bootstrap(urls, withOwnCheckbox) {
  return `<!doctype html><style>.scv-car-box{display:block;width:240px;height:80px}</style>
    <input id="pickup_country" value="119"><input id="dropoff_country" value="119">
    <input id="pickup_city" value="1744"><input id="dropoff_city" value="1744">
    <input id="pickup_location" value="10921"><input id="dropoff_location" value="10921">
    <input id="pickdate" value="2026-10-02"><input id="dropdate" value="2026-10-04">
    <input id="time_pickup" value="10:00"><input id="time_dropoff" value="10:00">
    <input name="currency" value="EUR"><input id="page_busy" value="1">
    <input id="price_range" value="0,1000" data-slider-min="0" data-slider-max="1000">
    <input id="filter_automatic" type="checkbox">
    ${withOwnCheckbox ? '<input id="supplier_checkbox_mm_cars_rental" type="checkbox" value="mm_cars_rental">' : ""}
    <span id="car_count_data">8</span><div id="results"></div>
    <script>
      window.SITE_URL = 'https://be.supplycars.com/be1';
      window.affiliate_cookie_data = 'fixture-affiliate';
      const own = () => document.getElementById('supplier_checkbox_mm_cars_rental')?.checked === true;
      window.create_filter_data_ajax = () => {
        const params = new URL(own() ? ${JSON.stringify(urls.own)} : ${JSON.stringify(urls.automatic)}).searchParams;
        params.delete('load_type');
        return params.toString();
      };
      const show = async (url, total) => {
        document.getElementById('page_busy').value = '1';
        const response = await fetch(url);
        document.getElementById('results').innerHTML = await response.text();
        document.getElementById('car_count_data').textContent = total;
        document.getElementById('page_busy').value = '0';
      };
      document.getElementById('filter_automatic').addEventListener('change', () => show(${JSON.stringify(urls.automatic)}, 8));
      document.getElementById('supplier_checkbox_mm_cars_rental')?.addEventListener('change', () => show(${JSON.stringify(urls.own)}, 3));
      show(${JSON.stringify(urls.initial)}, 8);
    </script>`;
}

const AUTOMATIC_PAGES = {
  sorted: [
    [card("a1", "A", 20), card("a2", "A", 22)],
    [card("b1", "B", 24), card("c1", "C", 26)],
    [card("d1", "D", 28), card("c2", "C", 30)],
    [card("m1", "MM Cars Rental", 60), card("e1", "E", 70)]
  ],
  unsorted: [
    [card("a1", "A", 20), card("a2", "A", 22)],
    [card("b1", "B", 18), card("c1", "C", 26)],
    [card("d1", "D", 28), card("c2", "C", 30)],
    [card("m1", "MM Cars Rental", 60), card("e1", "E", 70)]
  ],
  "own-in-leaders": [
    [card("a1", "A", 20), card("m1", "MM Cars Rental", 21)],
    [card("b1", "B", 24), card("c1", "C", 26)],
    [card("d1", "D", 28), card("c2", "C", 30)],
    [card("e1", "E", 70), card("e2", "E", 80)]
  ]
};
const OWN_PAGES = [[card("m2", "MM Cars Rental", 50), card("m3", "MM Cars Rental", 55)], [card("m4", "MM Cars Rental", 90)]];

async function runCase(browser, scenario) {
  const withOwnCheckbox = scenario !== "no-own-checkbox";
  const automaticPages = AUTOMATIC_PAGES[scenario] || AUTOMATIC_PAGES.sorted;
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vipcars-leaders-test-"));
  const config = { baseUrl: "https://www.vipcars.com", pickupDate: "2026-10-02", dropoffDate: "2026-10-04",
    pickupTime: "10:00", dropoffTime: "10:00", currentDurationDays: 2, driverAge: 30, currency: "EUR",
    transmission: "automatic", networkResults: true, priceLeaders: true, maxProvidersPerLocation: 25,
    // Up to seven result requests at the production three-second pacing.
    timeoutMs: 2000, attemptBudgetMs: 40000, artifactsDir };
  const scraper = new VipCarsScraper(config);
  const searchUrl = scraper.buildSearchUrl("Warsaw");
  const params = new URL(searchUrl).searchParams;
  for (const direction of ["pickup", "dropoff"]) {
    params.set(`${direction}_loc`, params.get(`${direction}_location`));
    params.delete(`${direction}_location`);
  }
  params.set("key", "opaque-test-session");
  params.set("load_type", "get_result_desktop");
  params.set("offset", "0"); params.set("car_page", "0");
  const initial = `https://be.supplycars.com/be1/node.php?${params}`;
  params.set("load_type", "get_result_desktop_filter");
  params.set("specs_checks", "automatic");
  params.set("price_range", "0,1000");
  params.set("sort_by", "2");
  params.delete("offset"); params.delete("car_page");
  const automatic = `https://be.supplycars.com/be1/node.php?${params}`;
  params.set("supplier_checks", "mm_cars_rental");
  const own = `https://be.supplycars.com/be1/node.php?${params}`;
  const requests = [];
  const adapter = { async newContext(options) {
    const context = await browser.newContext(options);
    return {
      addCookies: (...args) => context.addCookies(...args), close: () => context.close(),
      newPage: () => context.newPage(),
      route: (pattern, handler) => context.route(pattern, (route) => handler({
        request: () => route.request(), abort: (...args) => route.abort(...args),
        continue: async () => {
          const url = route.request().url();
          if (url === searchUrl) return route.fulfill({ status: 200, contentType: "text/html",
            body: bootstrap({ initial, automatic, own }, withOwnCheckbox) });
          const source = parseResultRequest(url, { includeFiltered: true });
          if (!source) return route.abort("aborted");
          if (route.request().method() === "OPTIONS") {
            return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*",
              "access-control-allow-headers": "*" } });
          }
          let html;
          if (source.params.get("load_type") === "get_result_desktop") {
            html = pageHtml([card("u1", "A", 20), card("u2", "A", 22)], 2, 1, 8);
          } else {
            const ownRequest = source.params.get("supplier_checks") === "mm_cars_rental";
            const index = source.params.has("offset") ? Number(source.params.get("offset")) / 2 : 0;
            requests.push(`${ownRequest ? "own" : "automatic"}:${index}`);
            html = ownRequest
              ? pageHtml(OWN_PAGES[index], (index + 1) * 2, index + 1, 3)
              : pageHtml(automaticPages[index], (index + 1) * 2, index + 1, 8);
          }
          return route.fulfill({ status: 200, contentType: "text/html",
            headers: { "access-control-allow-origin": "*" }, body: html });
        }
      }))
    };
  } };
  try {
    const result = await scraper.runSingleLocation(adapter, "Warsaw");
    assert.equal(result.ok, true, result.error?.message);
    const byProvider = Object.fromEntries(result.results.map((row) => [row.provider, row]));
    if (scenario === "sorted") {
      assert.deepEqual(requests, ["automatic:0", "automatic:1", "automatic:2", "own:0", "own:1"]);
      assert.deepEqual(Object.keys(byProvider).sort(), ["A", "B", "C", "D", "MM Cars Rental"]);
      assert.equal(byProvider["MM Cars Rental"].total_price, 50);
      assert.equal(byProvider["MM Cars Rental"].source, "search_own_filter");
      assert.equal(byProvider.A.source, "search");
    } else if (scenario === "own-in-leaders") {
      assert.deepEqual(requests, ["automatic:0", "automatic:1", "automatic:2"]);
      assert.equal(byProvider["MM Cars Rental"].total_price, 21);
      assert.equal(byProvider["MM Cars Rental"].source, "search");
    } else {
      assert.deepEqual(requests, ["automatic:0", "automatic:1", "automatic:2", "automatic:3"],
        "unsorted results or a missing own-supplier filter keep full pagination");
      assert.deepEqual(Object.keys(byProvider).sort(), ["A", "B", "C", "D", "E", "MM Cars Rental"]);
      assert.equal(byProvider["MM Cars Rental"].source, "search");
    }
    console.log(`PASS price leaders workflow: ${scenario}`);
  } finally { fs.rmSync(artifactsDir, { recursive: true, force: true }); }
}

function testRecommendationLeavesOwnRankEmptyBeyondLeaders() {
  const coverage = [{ pickup_date: "2026-10-02", dropoff_date: "2026-10-04", duration_days: "2", location: "Warsaw",
    status: "complete", result_count: "4", attempts: "1", error: "" }];
  const row = (provider, total, source = "search") => ({ location: "Warsaw", duration_days: "2", pickup_date: "2026-10-02",
    dropoff_date: "2026-10-04", provider, provider_rating: "", total_price: String(total),
    price_per_day: String(total / 2), pay_now_amount: String(total / 10), pay_now_currency: "EUR",
    currency: "EUR", source });
  const options = { expectedLocations: ["Warsaw"], expectedDurations: [2], expectedPickupCount: 1,
    rateZones: [{ location: "Warsaw", code: "WAR", name: "WARSZAWA - AIRPORT", metroplex: "Main Metroplex" }],
    exchangeRate: { pln_per_eur: 4, source: "NBP", effective_date: "2026-09-24" } };
  const beyond = buildRecommendations([row("A", 20), row("B", 24), row("C", 26),
    row("MM Cars Rental", 50, "search_own_filter")], coverage, options).decisions[0];
  assert.equal(beyond.mm_rank, null);
  assert.equal(beyond.mm_rate_eur_day, 25);
  const inside = buildRecommendations([row("A", 20), row("B", 24), row("C", 26), row("MM Cars Rental", 50)],
    coverage, options).decisions[0];
  assert.equal(inside.mm_rank, 4);
  assert.deepEqual(beyond.competitor_rates_eur_day, inside.competitor_rates_eur_day);
  assert.equal(beyond.action, inside.action);
  console.log("PASS own rank stays empty when MM Cars Rental is beyond the price leaders");
}

async function main() {
  testGateStopsOnlyAfterThreeCompetitorsAndAStrictlyHigherPrice();
  testOwnOffersAreNotCompetitorsAndAliasesAreOneProvider();
  testBrokenOrderOrUnreadablePriceDisablesEarlyStop();
  await testPaginationStopsWithoutFetchingLaterPages();
  testRecommendationLeavesOwnRankEmptyBeyondLeaders();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scenario of ["sorted", "own-in-leaders", "unsorted", "no-own-checkbox"]) await runCase(browser, scenario);
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
