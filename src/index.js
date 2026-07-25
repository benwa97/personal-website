/**
 * wvic-scraper-worker
 *
 * Ported from the Python scraper (wvic_flow_scraper.py). Runs on a
 * Cron Trigger every hour, scrapes the Rice and Willow reservoir
 * "hourly report" pages, and upserts readings into a Cloudflare KV
 * namespace (binding: WVIC_DATA), one JSON array per dam, keyed as
 * "readings:rice" / "readings:willow".
 *
 * Uses HTMLRewriter (built into Workers) instead of a DOM library to
 * pull table cell text -- same "find a cell that looks like a
 * timestamp, then read the next two cells" strategy as the Python
 * version, since these report pages mix title/notice rows in with
 * the real data rows.
 */

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

// max_elevation_ft: WVIC's authorized maximum elevation (ft NGVD 1929)
// for each reservoir, from WVIC's published weekly Reservoir Report
// PDFs ("Authorized Reservoir Water Level Limits" table). Confirmed
// stable across a 2023 report and a Jul-2026 report -- a regulatory
// constant, not day-to-day data. Update here if WVIC ever revises it.
const DAMS = {
  rice: {
    page_url: "https://www.wvic.com/Content/Rice_Flows.cfm",
    data_url: "https://wvic.com/TridentXML/RiceHourly/riceHourlyReport.html",
    max_elevation_ft: 1463.25,
  },
  willow: {
    page_url: "https://www.wvic.com/Content/Willow_Flows.cfm",
    data_url: "https://wvic.com/TridentXML/WillowHourly/willowHourlyReport.html",
    max_elevation_ft: 1529.35,
  },
};

const UA_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

// Matches the site's "MM/DD/YYYY HH:MM" timestamp format.
const DATE_RE = /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}$/;

// ---------------------------------------------------------------
// HTML table extraction (HTMLRewriter-based)
// ---------------------------------------------------------------

async function extractTableRows(html) {
  const rows = [];
  let currentRow = null;
  let currentCell = null;

  const rewriter = new HTMLRewriter()
    .on("tr", {
      element() {
        currentRow = [];
        rows.push(currentRow);
      },
    })
    .on("td", {
      element(el) {
        const cell = { text: "" };
        if (currentRow) currentRow.push(cell);
        currentCell = cell;
        el.onEndTag(() => {
          currentCell = null;
        });
      },
      text(chunk) {
        if (currentCell) currentCell.text += chunk.text;
      },
    });

  const res = new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  const transformed = rewriter.transform(res);
  await transformed.text(); // drive the (lazy/streaming) transform to completion

  return rows.map((row) => row.map((cell) => cell.text));
}

function clean(text) {
  // HTMLRewriter's text() handler does NOT decode &nbsp; the way a DOM
  // parser would -- it comes through as the literal 6-character string
  // "&nbsp;" rather than a real non-breaking space. Handle both forms,
  // in case that ever changes.
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function readingsFromRows(rows) {
  const readings = [];
  for (const row of rows) {
    const cells = row.map(clean);
    for (let i = 0; i < cells.length; i++) {
      if (DATE_RE.test(cells[i])) {
        readings.push({
          datetime: cells[i],
          head_level: cells[i + 1] || "",
          gate_flow: cells[i + 2] || "",
        });
        break; // only one timestamp expected per row
      }
    }
  }
  return readings;
}

// ---------------------------------------------------------------
// Fetching (with iframe fallback, mirroring the Python version)
// ---------------------------------------------------------------

async function fetchDataPage(dam) {
  const attempts = [];

  try {
    const res = await fetch(dam.data_url, { headers: UA_HEADERS });
    attempts.push({ url: dam.data_url, status: res.status, ok: res.ok });
    if (res.ok) {
      const html = await res.text();
      return { html, attempts, source: dam.data_url };
    }
  } catch (err) {
    attempts.push({ url: dam.data_url, error: String(err) });
  }

  const pageRes = await fetch(dam.page_url, { headers: UA_HEADERS });
  attempts.push({ url: dam.page_url, status: pageRes.status, ok: pageRes.ok });
  if (!pageRes.ok) {
    const err = new Error(`Fallback fetch of ${dam.page_url} failed: ${pageRes.status}`);
    err.diagnostics = { attempts };
    throw err;
  }
  const pageHtml = await pageRes.text();

  const match = pageHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (!match) {
    const err = new Error(`Could not find iframe on ${dam.page_url}`);
    err.diagnostics = { attempts, htmlSnippet: pageHtml.slice(0, 600) };
    throw err;
  }

  let iframeUrl = match[1];
  if (iframeUrl.startsWith("//")) iframeUrl = "https:" + iframeUrl;
  else if (iframeUrl.startsWith("/")) iframeUrl = "https://www.wvic.com" + iframeUrl;

  const res2 = await fetch(iframeUrl, { headers: UA_HEADERS });
  attempts.push({ url: iframeUrl, status: res2.status, ok: res2.ok });
  if (!res2.ok) {
    const err = new Error(`Iframe fetch of ${iframeUrl} failed: ${res2.status}`);
    err.diagnostics = { attempts };
    throw err;
  }
  const html = await res2.text();
  return { html, attempts, source: iframeUrl };
}

// ---------------------------------------------------------------
// KV upsert
// ---------------------------------------------------------------

function toFloat(v) {
  if (!v) return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

function parseSiteDate(s) {
  // "MM/DD/YYYY HH:MM" -> Date, for sorting only.
  const [datePart, timePart] = s.split(" ");
  const [mm, dd, yyyy] = datePart.split("/");
  return new Date(`${yyyy}-${mm}-${dd}T${timePart}:00`);
}

async function upsertReadings(env, damKey, readings, maxElevationFt, scrapeTimeIso) {
  const kvKey = `readings:${damKey}`;
  const existingJson = await env.WVIC_DATA.get(kvKey);
  const existing = existingJson ? JSON.parse(existingJson) : [];
  const byDatetime = new Map(existing.map((r) => [r.datetime, r]));

  let added = 0;
  let updated = 0;

  for (const r of readings) {
    if (!r.head_level && !r.gate_flow) continue; // hour not recorded yet -- skip

    const headVal = toFloat(r.head_level);
    const row = {
      datetime: r.datetime,
      head_level: r.head_level,
      gate_flow: r.gate_flow,
      feet_below_maximum:
        maxElevationFt != null && headVal != null
          ? Math.round((maxElevationFt - headVal) * 100) / 100
          : null,
      last_updated: scrapeTimeIso,
    };

    const prev = byDatetime.get(r.datetime);
    if (prev) {
      if (prev.head_level !== row.head_level || prev.gate_flow !== row.gate_flow) {
        updated++;
      }
    } else {
      added++;
    }
    byDatetime.set(r.datetime, row);
  }

  const merged = Array.from(byDatetime.values()).sort(
    (a, b) => parseSiteDate(a.datetime) - parseSiteDate(b.datetime)
  );

  await env.WVIC_DATA.put(kvKey, JSON.stringify(merged));
  return { added, updated, total: merged.length };
}

// ---------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------

async function scrapeDam(env, key) {
  const dam = DAMS[key];
  const { html, attempts, source } = await fetchDataPage(dam);
  const rows = await extractTableRows(html);
  const readings = readingsFromRows(rows);

  if (readings.length === 0) {
    const err = new Error(`No readings parsed for ${key} -- site layout may have changed`);
    err.diagnostics = {
      source,
      attempts,
      htmlLength: html.length,
      rowCount: rows.length,
      sampleRows: rows.slice(0, 6),
      htmlSnippet: html.slice(0, 800),
    };
    throw err;
  }

  const scrapeTimeIso = new Date().toISOString();
  const result = await upsertReadings(env, key, readings, dam.max_elevation_ft, scrapeTimeIso);

  // Distinct from the readings themselves: this is "when did we last
  // successfully reach WVIC's site and parse it", updated on every
  // successful scrape whether or not WVIC had published anything new.
  // Only written on success -- if scraping starts failing, this value
  // freezes at the last known-good sync rather than lying about it.
  await env.WVIC_DATA.put(`last_synced:${key}`, scrapeTimeIso);

  return { dam: key, ...result };
}

async function scrapeAll(env) {
  const results = [];
  for (const key of Object.keys(DAMS)) {
    try {
      results.push(await scrapeDam(env, key));
    } catch (err) {
      results.push({
        dam: key,
        error: String(err && err.message ? err.message : err),
        diagnostics: err && err.diagnostics ? err.diagnostics : undefined,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------

export default {
  // Cron Trigger (configured in wrangler.toml) calls this hourly.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scrapeAll(env));
  },

  // Manual trigger for testing, e.g.:
  //   curl "https://wvic-scraper-worker.<you>.workers.dev/trigger?key=YOUR_SECRET"
  // Set TRIGGER_SECRET with: wrangler secret put TRIGGER_SECRET
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/trigger") {
      if (!env.TRIGGER_SECRET || url.searchParams.get("key") !== env.TRIGGER_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const results = await scrapeAll(env);
      return Response.json(results);
    }

    return new Response(
      "wvic-scraper-worker is running. GET /trigger?key=... to run a scrape manually.",
      { status: 200 }
    );
  },
};
