/* ------------------------------------------------------------------
   Reservoir Gauge — reservoir-app.js

   Fetches JSON from /api/reservoir?dam=rice|willow (a Cloudflare Pages
   Function backed by KV, populated hourly by wvic-scraper-worker) and
   renders current readings, trend charts, and a recent-readings table.

   Chart.js is imported as a proper npm dependency (run `npm install
   chart.js` in the project root) and bundled by Astro/Vite at build
   time -- no external CDN script tag, no runtime dependency on a
   third-party host being reachable.
------------------------------------------------------------------- */

import Chart from "chart.js/auto";
import "chartjs-adapter-date-fns";

const SOURCES = {
  rice: { label: "Rice Reservoir", color: "#2C6E7F" },
  willow: { label: "Willow Reservoir", color: "#4B7F52" },
};

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // re-check the API every 5 minutes
const STALE_AFTER_MS = 3 * 60 * 60 * 1000; // flag as stale if latest reading is >3h old

const state = {
  activeDam: "rice",
  range: "7",
  data: {}, // dam key -> array of row objects
};

let levelChart = null;
let flowChart = null;

function toNumber(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

// Source datetimes look like "07/24/2026 20:00" (site's local time, no TZ).
function parseSiteDatetime(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(s || "");
  if (!m) return null;
  const [, mo, d, y, h, mi] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
}

// ---------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------

async function loadDam(key) {
  const res = await fetch(`/api/reservoir?dam=${key}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load data for ${key} (${res.status})`);
  const raw = await res.json();
  return raw
    .map((r) => ({
      datetime: parseSiteDatetime(r.datetime),
      head_level: toNumber(r.head_level),
      gate_flow: toNumber(r.gate_flow),
      feet_below_maximum: toNumber(r.feet_below_maximum),
      last_updated: r.last_updated || "",
    }))
    .filter((r) => r.datetime !== null)
    .sort((a, b) => a.datetime - b.datetime);
}

async function loadAll() {
  const results = await Promise.allSettled(
    Object.keys(SOURCES).map((k) => loadDam(k))
  );
  Object.keys(SOURCES).forEach((k, idx) => {
    const r = results[idx];
    if (r.status === "fulfilled") state.data[k] = r.value;
    else console.error(`[reservoir-gauge] failed to load ${k}:`, r.reason);
  });
}

// ---------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------

const fmt1 = (n) => (n === null || n === undefined ? "\u2014" : n.toFixed(1));
const fmt2 = (n) => (n === null || n === undefined ? "\u2014" : n.toFixed(2));
const fmt0 = (n) => (n === null || n === undefined ? "\u2014" : Math.round(n).toString());

function fmtDateTime(d) {
  if (!d) return "\u2014";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function fmtTableDate(d) {
  if (!d) return "\u2014";
  return d.toLocaleString(undefined, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------

function filteredRows(key) {
  const rows = state.data[key] || [];
  if (state.range === "all") return rows;
  const days = Number(state.range);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return rows.filter((r) => r.datetime.getTime() >= cutoff);
}

function renderGauges(key) {
  const rows = state.data[key] || [];
  const latest = rows[rows.length - 1];

  document.getElementById("value-head").textContent = latest ? fmt2(latest.head_level) : "\u2014";
  document.getElementById("value-flow").textContent = latest ? fmt0(latest.gate_flow) : "\u2014";
  document.getElementById("value-fbm").textContent = latest ? fmt2(latest.feet_below_maximum) : "\u2014";
  document.getElementById("as-of-time").textContent = latest ? fmtDateTime(latest.datetime) : "\u2014";

  const dot = document.getElementById("freshness-dot");
  const label = document.getElementById("freshness-label");
  if (!latest) {
    dot.classList.add("is-stale");
    label.textContent = "No data available";
    return;
  }
  const age = Date.now() - latest.datetime.getTime();
  if (age > STALE_AFTER_MS) {
    dot.classList.add("is-stale");
    label.textContent = `Last reading ${fmtDateTime(latest.datetime)} — may be stale`;
  } else {
    dot.classList.remove("is-stale");
    label.textContent = `Updated ${fmtDateTime(latest.datetime)}`;
  }
}

// ---------------------------------------------------------------
// Flow balance (Rice only -- Willow's release is Rice's inflow;
// there's no equivalent upstream data to do this for Willow itself)
// ---------------------------------------------------------------

const FLOW_DEADBAND_CFS = 1; // ignore differences smaller than this as "steady"

function computeFlowBalance() {
  const riceRows = state.data.rice || [];
  const willowRows = state.data.willow || [];
  if (riceRows.length === 0 || willowRows.length === 0) return null;

  const riceLatest = riceRows[riceRows.length - 1];

  // Willow's release becomes Rice's inflow. Match the most recent Willow
  // reading at or before Rice's latest timestamp (both are scraped in the
  // same hourly run, so these normally line up to the same hour; this
  // just guards against the rare case where one dam's page hadn't
  // updated yet at scrape time).
  let willowMatch = null;
  for (let i = willowRows.length - 1; i >= 0; i--) {
    if (willowRows[i].datetime <= riceLatest.datetime) {
      willowMatch = willowRows[i];
      break;
    }
  }
  if (!willowMatch) willowMatch = willowRows[willowRows.length - 1];

  const inflow = willowMatch.gate_flow;
  const outflow = riceLatest.gate_flow;
  if (inflow === null || outflow === null) return null;

  const netFlow = inflow - outflow; // positive = gaining water, negative = losing
  const pctDiff = inflow !== 0 ? ((outflow - inflow) / inflow) * 100 : null;

  let trend = "steady";
  if (Math.abs(netFlow) >= FLOW_DEADBAND_CFS) {
    trend = netFlow > 0 ? "rising" : "falling";
  }

  return {
    inflow,
    outflow,
    netFlow,
    pctDiff,
    trend,
    inflowTime: willowMatch.datetime,
    outflowTime: riceLatest.datetime,
  };
}

function computeNetFlowSeries(days) {
  const riceRows = state.data.rice || [];
  const willowRows = state.data.willow || [];
  if (riceRows.length === 0 || willowRows.length === 0) return [];

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const relevant = riceRows.filter((r) => r.datetime.getTime() >= cutoff);

  let wi = 0; // both arrays are sorted ascending by datetime
  const series = [];
  for (const r of relevant) {
    while (wi + 1 < willowRows.length && willowRows[wi + 1].datetime <= r.datetime) wi++;
    const w = willowRows[wi];
    if (!w || w.datetime > r.datetime) continue;
    if (r.gate_flow === null || w.gate_flow === null) continue;
    series.push({ x: r.datetime, y: w.gate_flow - r.gate_flow });
  }
  return series;
}

let netFlowChart = null;

function renderNetFlowSparkline() {
  const canvas = document.getElementById("chart-netflow");
  if (!canvas) return;

  if (netFlowChart) {
    netFlowChart.destroy();
    netFlowChart = null;
  }

  const series = computeNetFlowSeries(7);
  if (series.length < 2) return; // not enough points to draw a meaningful line

  const moss = "#4B7F52";
  const rust = "#A13D2E";
  const bothPositive = (c) => c.p0.parsed.y >= 0 && c.p1.parsed.y >= 0;
  const bothNegative = (c) => c.p0.parsed.y < 0 && c.p1.parsed.y < 0;

  netFlowChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      datasets: [
        {
          data: series,
          borderWidth: 1.75,
          pointRadius: 0,
          tension: 0.2,
          fill: { target: { value: 0 } },
          segment: {
            borderColor: (c) => (bothPositive(c) ? moss : bothNegative(c) ? rust : undefined),
            backgroundColor: (c) => (bothPositive(c) ? moss + "26" : rust + "26"),
          },
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { type: "time", display: false },
        y: { display: false },
      },
    },
  });
}

function renderFlowBalance() {
  const panel = document.getElementById("flow-balance-panel");

  // Native `hidden` attribute rather than a CSS class -- avoids any
  // dependency on stylesheet load order/specificity for something this
  // important to actually hide.
  panel.hidden = state.activeDam !== "rice";
  if (panel.hidden) return;

  const fb = computeFlowBalance();
  const icon = document.getElementById("trend-icon");
  const trendLabel = document.getElementById("trend-label");
  icon.classList.remove("rising", "falling", "steady");

  if (!fb) {
    icon.textContent = "\u2014";
    trendLabel.textContent = "Not enough data yet";
    document.getElementById("value-net-flow").textContent = "\u2014";
    document.getElementById("bar-inflow").style.width = "0%";
    document.getElementById("bar-outflow").style.width = "0%";
    document.getElementById("value-inflow").textContent = "\u2014";
    document.getElementById("value-outflow-balance").textContent = "\u2014";
    document.getElementById("balance-summary").textContent =
      "Not enough data yet to compare inflow and outflow.";
    renderNetFlowSparkline();
    return;
  }

  const maxVal = Math.max(fb.inflow, fb.outflow, 1);
  document.getElementById("bar-inflow").style.width = `${(fb.inflow / maxVal) * 100}%`;
  document.getElementById("bar-outflow").style.width = `${(fb.outflow / maxVal) * 100}%`;
  document.getElementById("value-inflow").textContent = `${fmt0(fb.inflow)} cfs`;
  document.getElementById("value-outflow-balance").textContent = `${fmt0(fb.outflow)} cfs`;

  const trendMeta = {
    rising: { arrow: "\u25B2", label: "Level rising" },
    falling: { arrow: "\u25BC", label: "Level falling" },
    steady: { arrow: "\u25CF", label: "Level steady" },
  }[fb.trend];
  icon.classList.add(fb.trend);
  icon.textContent = trendMeta.arrow;
  trendLabel.textContent = trendMeta.label;

  const netSign = fb.netFlow >= 0 ? "+" : "\u2212";
  document.getElementById("value-net-flow").textContent = `${netSign}${fmt0(Math.abs(fb.netFlow))}`;

  let pctText = "Inflow and outflow are matched";
  if (fb.pctDiff !== null && Math.abs(fb.netFlow) >= FLOW_DEADBAND_CFS) {
    pctText =
      fb.pctDiff > 0
        ? `Outflow is ${fmt1(Math.abs(fb.pctDiff))}% higher than inflow`
        : `Inflow is ${fmt1(Math.abs(fb.pctDiff))}% higher than outflow`;
  }
  document.getElementById("balance-summary").textContent = pctText;

  renderNetFlowSparkline();
}

function renderTable(key) {
  const rows = filteredRows(key).slice(-24).reverse();
  const tbody = document.getElementById("readings-tbody");
  tbody.innerHTML = "";

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-row">No readings in this range.</td></tr>';
    return;
  }

  const frag = document.createDocumentFragment();
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtTableDate(r.datetime)}</td>
      <td>${fmt2(r.head_level)}</td>
      <td>${fmt0(r.gate_flow)}</td>
      <td>${fmt2(r.feet_below_maximum)}</td>
    `;
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
}

function renderCharts(key) {
  const rows = filteredRows(key);
  const color = SOURCES[key].color;
  const labels = rows.map((r) => r.datetime);

  const levelCtx = document.getElementById("chart-level").getContext("2d");
  const flowCtx = document.getElementById("chart-flow").getContext("2d");

  if (levelChart) levelChart.destroy();
  if (flowChart) flowChart.destroy();

  const gridColor = "rgba(22,50,58,0.08)";
  const tickColor = "#4C625F";
  const fontFamily = "'IBM Plex Mono', monospace";

  levelChart = new Chart(levelCtx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Head Level (ft)",
          data: rows.map((r) => r.head_level),
          borderColor: color,
          backgroundColor: color + "22",
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.15,
          fill: true,
          yAxisID: "yLevel",
        },
        {
          label: "Below Maximum (ft)",
          data: rows.map((r) => r.feet_below_maximum),
          borderColor: "#B5793C",
          borderWidth: 1.5,
          borderDash: [3, 3],
          pointRadius: 0,
          tension: 0.15,
          yAxisID: "yFbm",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          align: "end",
          labels: { color: tickColor, font: { family: fontFamily, size: 11 }, boxWidth: 12 },
        },
        tooltip: {
          titleFont: { family: fontFamily },
          bodyFont: { family: fontFamily },
        },
      },
      scales: {
        x: {
          type: "time",
          time: { unit: state.range === "7" ? "day" : "week" },
          grid: { color: gridColor },
          ticks: { color: tickColor, font: { family: fontFamily, size: 10 } },
        },
        yLevel: {
          position: "left",
          grid: { color: gridColor },
          ticks: { color: tickColor, font: { family: fontFamily, size: 10 } },
          title: { display: true, text: "ft NGVD 29", color: tickColor, font: { family: fontFamily, size: 10 } },
        },
        yFbm: {
          position: "right",
          reverse: true,
          grid: { display: false },
          ticks: { color: tickColor, font: { family: fontFamily, size: 10 } },
          title: { display: true, text: "ft below max", color: tickColor, font: { family: fontFamily, size: 10 } },
        },
      },
    },
  });

  flowChart = new Chart(flowCtx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Gate Flow (cfs)",
          data: rows.map((r) => r.gate_flow),
          borderColor: "#B5793C",
          backgroundColor: "#B5793C22",
          borderWidth: 2,
          stepped: true,
          pointRadius: 0,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { titleFont: { family: fontFamily }, bodyFont: { family: fontFamily } },
      },
      scales: {
        x: {
          type: "time",
          time: { unit: state.range === "7" ? "day" : "week" },
          grid: { color: gridColor },
          ticks: { color: tickColor, font: { family: fontFamily, size: 10 } },
        },
        y: {
          grid: { color: gridColor },
          ticks: { color: tickColor, font: { family: fontFamily, size: 10 } },
          title: { display: true, text: "cfs", color: tickColor, font: { family: fontFamily, size: 10 } },
        },
      },
    },
  });
}

function renderAll() {
  renderGauges(state.activeDam);
  renderFlowBalance();
  renderCharts(state.activeDam);
  renderTable(state.activeDam);
}

// ---------------------------------------------------------------
// Interaction wiring
// ---------------------------------------------------------------

function wireTabs() {
  document.querySelectorAll(".dam-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".dam-tab").forEach((b) => b.setAttribute("aria-selected", "false"));
      btn.setAttribute("aria-selected", "true");
      state.activeDam = btn.dataset.dam;
      renderAll();
    });
  });
}

function wireRangeToggle() {
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.range = btn.dataset.range;
      renderCharts(state.activeDam);
      renderTable(state.activeDam);
    });
  });
}

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------

async function init() {
  wireTabs();
  wireRangeToggle();
  try {
    await loadAll();
    renderAll();
  } catch (err) {
    console.error(err);
    document.getElementById("freshness-label").textContent = "Failed to load data";
    document.getElementById("freshness-dot").classList.add("is-stale");
  }

  setInterval(async () => {
    try {
      await loadAll();
      renderAll();
    } catch (err) {
      console.error("[reservoir-gauge] refresh failed:", err);
    }
  }, REFRESH_INTERVAL_MS);
}

document.addEventListener("DOMContentLoaded", init);
