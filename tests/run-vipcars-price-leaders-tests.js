const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { createPriceLeaderGate } = require("../src/vipcars/priceLeaders");
const { collectResultPages, parseResultRequest } = require("../src/vipcars/resultTransport");
const { VipCarsScraper } = require("../src/vipcars/scraper");
const { buildRecommendations } = require("../src/vipcars/pricingRecommendations");
const { buildHtmlReport } = require("../src/vipcars/reportHtml");

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

function testOwnTieAtTheBoundaryKeepsPaginating() {
  const leaders = gate();
  const cards = [offer("1", "A", 10), offer("2", "B", 11), offer("3", "C", 12), offer("4", "MM Cars Rental", 13)];
  assert.equal(leaders.shouldStop(cards), false, "a later offer at MM's daily rate could rank before it");
  assert.equal(leaders.shouldStop([...cards, offer("5", "Delta", 13)]), false);
  assert.equal(leaders.shouldStop([...cards, offer("5", "Delta", 13), offer("6", "E", 14)]), true);
  console.log("PASS a tie with MM Cars Rental at the boundary keeps pagination going");
}

function testOrderUsesTheRentalTotalNotTheRoundedDailyRate() {
  const leaders = createPriceLeaderGate({ durationDays: 14 });
  assert.equal(leaders.shouldStop([offer("1", "A", 100), offer("2", "B", 120), offer("3", "C", 140.02),
    offer("4", "D", 140.01), offer("5", "E", 200)]), false);
  assert.equal(leaders.state.ordered, false, "140.01 after 140.02 is out of order although both round to 10.00/day");
  console.log("PASS price order is checked on the rental total, not the rounded daily rate");
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

function card(id, provider, price, payNow = price / 10) {
  return `<article class="scv-car-box" id="${id}">
    <div class="scv-supp-info"><img alt="${provider}"></div>
    <div class="scv-car-name">Fixture car</div><div class="scv-car-cat">Economy</div>
    <div class="scv-new-amount">EUR ${price.toFixed(2)}</div><div class="scv-pay-now">Pay Now EUR ${payNow.toFixed(2)}</div>
    <ul class="scv-car-specs"><li><i class="scv-icon autom"></i>Automatic transmission</li></ul>
  </article>`;
}

function pageHtml(cards, nextOffset, nextPage, total) {
  return cards.join("") + `<script>$("#offset").val(${nextOffset});$("#car_page").val(${nextPage});
    $("#car_count_data").val(${total});</script>`;
}

function bootstrap(urls, ownCheckbox, ownTotal, { lateOwn = false, ownSliderMin = 0 } = {}) {
  return `<!doctype html><style>.scv-car-box{display:block;width:240px;height:80px}</style>
    <input id="pickup_country" value="119"><input id="dropoff_country" value="119">
    <input id="pickup_city" value="1744"><input id="dropoff_city" value="1744">
    <input id="pickup_location" value="10921"><input id="dropoff_location" value="10921">
    <input id="pickdate" value="2026-10-02"><input id="dropdate" value="2026-10-04">
    <input id="time_pickup" value="10:00"><input id="time_dropoff" value="10:00">
    <input name="currency" value="EUR"><input id="page_busy" value="1">
    <input id="price_range" value="0,1000" data-slider-min="0" data-slider-max="1000">
    <input id="filter_automatic" type="checkbox">
    ${ownCheckbox === "fieldset-disabled" ? "<fieldset disabled>" : ""}
    ${ownCheckbox ? `<input id="supplier_checkbox_mm_cars_rental" type="checkbox" value="mm_cars_rental"${ownCheckbox === "disabled" ? " disabled" : ""}>` : ""}
    ${ownCheckbox === "fieldset-disabled" ? "</fieldset>" : ""}
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
      const show = async (url, total, late = false) => {
        document.getElementById('page_busy').value = '1';
        const response = await fetch(url);
        const html = await response.text();
        const results = document.getElementById('results');
        document.getElementById('car_count_data').textContent = total;
        document.getElementById('page_busy').value = '0';
        if (!late) { results.innerHTML = html; return; }
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const cards = [...parsed.querySelectorAll('.scv-car-box')];
        results.innerHTML = cards[0].outerHTML;
        setTimeout(() => { results.innerHTML = html; }, 1500);
      };
      document.getElementById('filter_automatic').addEventListener('change', () => show(${JSON.stringify(urls.automatic)}, 8));
      document.getElementById('supplier_checkbox_mm_cars_rental')?.addEventListener('change', () => {
        document.getElementById('price_range').setAttribute('data-slider-min', '${ownSliderMin}');
        show(${JSON.stringify(urls.own)}, ${ownTotal}, ${lateOwn});
      });
      show(${JSON.stringify(urls.initial)}, 8);
    </script>`;
}

const SORTED = [
  [card("a1", "A", 20), card("a2", "A", 22)],
  [card("b1", "B", 24), card("c1", "C", 26)],
  [card("d1", "D", 28), card("c2", "C", 30)],
  [card("m1", "MM Cars Rental", 60), card("m2", "MM Cars Rental", 65)]
];
const AUTOMATIC_PAGES = {
  sorted: SORTED,
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
AUTOMATIC_PAGES["own-tie-paynow"] = [...SORTED.slice(0, 3),
  [card("m1", "MM Cars Rental", 60, 6), card("m2", "MM Cars Rental", 60, 12)]];

// The own-supplier filter must describe the same result set as the sorted list above.
const OWN_PAGES = {
  sorted: [[card("m1", "MM Cars Rental", 60), card("m2", "MM Cars Rental", 65)]],
  "contradicting-own": [[card("m1", "MM Cars Rental", 25), card("m2", "MM Cars Rental", 65)]],
  "foreign-own": [[card("a1", "A", 20), card("m2", "MM Cars Rental", 65)]],
  "duplicate-id-own": [[card("d1", "MM Cars Rental", 60), card("m2", "MM Cars Rental", 65)]],
  "own-tie-paynow": [[card("m2", "MM Cars Rental", 60, 12), card("m1", "MM Cars Rental", 60, 6)]],
  "own-empty": [[]],
  "own-wrong-range": [[card("m2", "MM Cars Rental", 65)]]
};
const FULL_PAGINATION = ["unsorted", "no-own-checkbox", "disabled-own-checkbox", "fieldset-disabled-own", "double-sort"];
const REJECTED = { "contradicting-own": /contradict/, "foreign-own": /another supplier/,
  "duplicate-id-own": /contradict/, "own-wrong-range": /changes the search/ };

async function runCase(browser, scenario) {
  const checkboxStates = { "no-own-checkbox": null, "disabled-own-checkbox": "disabled",
    "fieldset-disabled-own": "fieldset-disabled" };
  const ownCheckbox = scenario in checkboxStates ? checkboxStates[scenario] : "enabled";
  if (scenario === "own-empty") AUTOMATIC_PAGES[scenario] = [...SORTED.slice(0, 3), [card("e1", "E", 70), card("e2", "E", 80)]];
  const automaticPages = AUTOMATIC_PAGES[scenario] || AUTOMATIC_PAGES.sorted;
  const ownPages = OWN_PAGES[scenario] || OWN_PAGES.sorted;
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
  if (scenario === "double-sort") params.append("sort_by", "1");
  params.delete("offset"); params.delete("car_page");
  const automatic = `https://be.supplycars.com/be1/node.php?${params}`;
  params.set("supplier_checks", "mm_cars_rental");
  if (scenario === "own-wrong-range") params.set("price_range", "63,1000");
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
            body: bootstrap({ initial, automatic, own }, ownCheckbox, ownPages.flat().length,
              { lateOwn: scenario === "own-late-render", ownSliderMin: scenario === "own-wrong-range" ? 63 : 0 }) });
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
              ? (ownPages.flat().length
                ? pageHtml(ownPages[index], (index + 1) * 2, index + 1, ownPages.flat().length)
                : '<div class="notFoundImg"><img alt="No Results Found" width="200" height="200"></div>')
              : pageHtml(automaticPages[index], (index + 1) * 2, index + 1, 8);
          }
          return route.fulfill({ status: 200, contentType: "text/html",
            headers: { "access-control-allow-origin": "*" }, body: html });
        }
      }))
    };
  } };
  try {
    let timing;
    if (scenario === "own-tie-paynow") {
      // Equal cheapest MM offers with different Pay Now: the retry uses full pagination, which keeps
      // the main list's first offer exactly as before price leaders existed.
      const result = await scraper.runLocationWithRetries(adapter, "Warsaw", { maxAttemptsPerCheck: 2 });
      assert.equal(result.ok, true, result.error?.message);
      assert.deepEqual(requests, ["automatic:0", "automatic:1", "automatic:2", "own:0",
        "automatic:0", "automatic:1", "automatic:2", "automatic:3"]);
      const mm = result.results.find((row) => row.provider === "MM Cars Rental");
      assert.equal(mm.pay_now_amount, 6);
      assert.equal(mm.source, "search");
      console.log(`PASS price leaders workflow: ${scenario}`);
      return;
    }
    const result = await scraper.runSingleLocation(adapter, "Warsaw", { onDiagnostics: (value) => { timing = value; } });
    if (REJECTED[scenario]) {
      assert.equal(result.ok, false, "inconsistent own-supplier offers must not be priced");
      assert.equal(result.error.code, "RESULT_TRANSPORT_INVALID");
      assert.match(result.error.message, REJECTED[scenario]);
      assert.deepEqual(requests, ["automatic:0", "automatic:1", "automatic:2", "own:0"]);
      console.log(`PASS price leaders workflow: ${scenario}`);
      return;
    }
    assert.equal(result.ok, true, result.error?.message);
    const byProvider = Object.fromEntries(result.results.map((row) => [row.provider, row]));
    if (scenario === "own-empty") {
      assert.deepEqual(requests, ["automatic:0", "automatic:1", "automatic:2", "own:0"]);
      assert.deepEqual(Object.keys(byProvider).sort(), ["A", "B", "C", "D"], "a confirmed empty filter means no MM offer");
    } else if (scenario === "sorted" || scenario === "own-late-render") {
      assert.deepEqual(requests, ["automatic:0", "automatic:1", "automatic:2", "own:0"]);
      assert.deepEqual(Object.keys(byProvider).sort(), ["A", "B", "C", "D", "MM Cars Rental"]);
      assert.equal(byProvider["MM Cars Rental"].total_price, 60);
      assert.equal(byProvider["MM Cars Rental"].source, "search_own_filter");
      assert.equal(byProvider.A.source, "search");
      assert.equal(timing.result_state.pageCount, 4, "TIMING counts the leaders' and the own-supplier pages");
    } else if (scenario === "own-in-leaders") {
      assert.deepEqual(requests, ["automatic:0", "automatic:1", "automatic:2"]);
      assert.equal(byProvider["MM Cars Rental"].total_price, 21);
      assert.equal(byProvider["MM Cars Rental"].source, "search");
    } else {
      assert.ok(FULL_PAGINATION.includes(scenario));
      assert.deepEqual(requests, ["automatic:0", "automatic:1", "automatic:2", "automatic:3"],
        "unsorted results, an ambiguous sort or an unusable own-supplier filter keep full pagination");
      assert.deepEqual(Object.keys(byProvider).sort(),
        scenario === "unsorted" ? ["A", "B", "C", "D", "E", "MM Cars Rental"] : ["A", "B", "C", "D", "MM Cars Rental"]);
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

function testReportKeepsOwnPriceButNoRankBeyondLeaders() {
  const row = (provider, perDay, source = "search") => ({ location: "Warsaw", duration_days: "2",
    pickup_date: "2026-10-02", dropoff_date: "2026-10-04", provider, provider_rating: "",
    price_per_day: String(perDay), currency: "EUR", source });
  const coverage = [{ location: "Warsaw", duration_days: "2", pickup_date: "2026-10-02", dropoff_date: "2026-10-04",
    status: "complete", result_count: "4", error: "" }];
  const html = buildHtmlReport([row("A", 10), row("B", 12), row("C", 13),
    row("MM Cars Rental", 30, "search_own_filter")], "2026-10-01T05:00:00.000Z", coverage);
  const warsaw = html.slice(html.indexOf('<tr data-location="Warsaw"'));
  const cells = warsaw.slice(0, warsaw.indexOf("</tr>"));
  assert.match(cells, /Poza czołówką/);
  assert.match(cells, /30\.00 EUR\/day/, "the exact MM Cars Rental price stays visible");
  assert.doesNotMatch(cells, /Top 4/);
  assert.equal([...cells.matchAll(/MM Cars Rental/g)].length, 0, "the own offer is not placed in a Top column");
  assert.match(html, /data-mm-state="beyond-leaders"/);
  assert.match(html, /MM close: 0 \| MM top1 gap: 0 \| MM poza czołówką: 1/,
    "an unknown gap is counted separately, not as a confirmed absence of close rivals");
  console.log("PASS report keeps the own price but no rank beyond the price leaders");
}

async function main() {
  testGateStopsOnlyAfterThreeCompetitorsAndAStrictlyHigherPrice();
  testOwnOffersAreNotCompetitorsAndAliasesAreOneProvider();
  testOwnTieAtTheBoundaryKeepsPaginating();
  testOrderUsesTheRentalTotalNotTheRoundedDailyRate();
  testBrokenOrderOrUnreadablePriceDisablesEarlyStop();
  await testPaginationStopsWithoutFetchingLaterPages();
  testRecommendationLeavesOwnRankEmptyBeyondLeaders();
  testReportKeepsOwnPriceButNoRankBeyondLeaders();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scenario of ["sorted", "own-in-leaders", "own-late-render", "own-empty", "unsorted", "no-own-checkbox",
      "disabled-own-checkbox", "fieldset-disabled-own", "double-sort", "contradicting-own", "foreign-own",
      "duplicate-id-own", "own-wrong-range", "own-tie-paynow"]) await runCase(browser, scenario);
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
