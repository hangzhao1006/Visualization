import { useState, useEffect, useRef, useCallback } from "react";

const NOTION_MCP = "https://mcp.notion.com/mcp";
const HANG_DS = "collection://e4a0c5c3-9082-4a4b-94d6-e9c4f32e4698";
const TONG_DS = "collection://33808633-7761-8164-b8eb-000bbd96de63";

const COLORS = {
  New: "#5DCAA5", Applied: "#7DBCE8", OA: "#F2C96B",
  Interview: "#B0A6E8", Rejected: "#EE9090", Offer: "#7BCF7B",
};
const STATUS_ORDER = ["New", "Applied", "OA", "Interview", "Rejected", "Offer"];

function normalizeStatus(s) {
  if (!s) return null;
  if (s.includes("Applied")) return "Applied";
  if (s.includes("Interview")) return "Interview";
  if (s.includes("Offer")) return "Offer";
  if (s.includes("Rejected")) return "Rejected";
  if (s.includes("Withdrawn")) return null;
  if (s === "OA") return "OA";
  if (s.includes("To Apply")) return null;
  return "Applied";
}

async function fetchNotionData(dataSourceUrl, name) {
  const prompt = `Search the Notion data source at ${dataSourceUrl} for ALL internship applications. Return ONLY a JSON array where each item has: {"company": "...", "status": "...", "appliedDate": "YYYY-MM-DD"}. Include every single row. Do not omit any. Return raw JSON only, no markdown.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
      mcp_servers: [{ type: "url", url: NOTION_MCP, name: "notion" }],
    }),
  });
  const data = await res.json();

  // Extract text from response
  const texts = data.content
    ?.filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // Try to parse JSON from the response
  try {
    const jsonMatch = texts.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error("Parse error for", name, e);
  }
  return [];
}

function processData(rawEntries) {
  // Group by applied date, map to step columns
  const dateSet = new Set();
  rawEntries.forEach((e) => {
    if (e.appliedDate) dateSet.add(e.appliedDate);
  });
  const sortedDates = [...dateSet].sort();
  if (!sortedDates.length) return { steps: [], rows: [], colTotals: [] };

  // Merge close dates into steps (group by 2-3 day windows)
  const steps = [];
  let i = 0;
  while (i < sortedDates.length) {
    const start = sortedDates[i];
    const startDay = new Date(start + "T00:00:00").getDate();
    let end = start;
    let j = i + 1;
    while (j < sortedDates.length) {
      const d = new Date(sortedDates[j] + "T00:00:00").getDate();
      if (d - startDay <= 1) { end = sortedDates[j]; j++; }
      else break;
    }
    const label = start === end
      ? `${new Date(start + "T00:00:00").getMonth() + 1}/${new Date(start + "T00:00:00").getDate()}`
      : `${new Date(start + "T00:00:00").getMonth() + 1}/${new Date(start + "T00:00:00").getDate()}–${new Date(end + "T00:00:00").getDate()}`;
    steps.push({ label, dates: sortedDates.slice(i, j) });
    i = j;
  }
  // Add "today" as final step
  steps.push({ label: "Today", dates: ["today"] });

  const nSteps = steps.length;

  // Build rows: group by (company, status) within each applied-date step
  const companyGroups = {};
  rawEntries.forEach((e) => {
    const status = normalizeStatus(e.status);
    if (!status) return;
    const stepIdx = steps.findIndex((s) => s.dates.includes(e.appliedDate));
    if (stepIdx < 0) return;
    const key = `${stepIdx}|${e.company}|${status}`;
    if (!companyGroups[key]) companyGroups[key] = { company: e.company, status, stepIdx, count: 0 };
    companyGroups[key].count++;
  });

  // Convert to row format: [label, weight, s0, s1, ..., sN]
  const rows = Object.values(companyGroups).map((g) => {
    const arr = new Array(nSteps + 2);
    arr[0] = g.count > 1 ? `${g.company} ×${g.count}` : g.company;
    arr[1] = g.count;
    for (let si = 0; si < nSteps; si++) {
      if (si < g.stepIdx) arr[si + 2] = null;
      else if (si === g.stepIdx) arr[si + 2] = "New";
      else if (si === nSteps - 1) arr[si + 2] = g.status; // final status
      else arr[si + 2] = g.status === "Rejected" ? null : (g.status === "OA" || g.status === "Interview" || g.status === "Offer") ? g.status : "Applied";
    }
    // If rejected, find a middle step to show it
    if (g.status === "Rejected") {
      const mid = Math.min(g.stepIdx + 1, nSteps - 1);
      for (let si = g.stepIdx + 1; si < mid; si++) arr[si + 2] = "Applied";
      arr[mid + 2] = "Rejected";
      for (let si = mid + 1; si < nSteps; si++) arr[si + 2] = null;
      if (mid === g.stepIdx) { arr[g.stepIdx + 2] = "New"; if (g.stepIdx + 1 < nSteps) arr[g.stepIdx + 3] = "Rejected"; }
    }
    return arr;
  });

  const colTotals = [];
  for (let si = 0; si < nSteps; si++) colTotals.push(rows.reduce((s, r) => (r[si + 2] ? s + r[1] : s), 0));

  return { steps: steps.map((s) => s.label), rows, colTotals };
}

function SankeyChart({ title, steps, rows }) {
  const ref = useRef();
  const [tooltip, setTooltip] = useState(null);

  useEffect(() => {
    if (!ref.current || !rows.length) return;
    const svg = ref.current;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const N = steps.length, bW = 10;
    const sO = STATUS_ORDER;
    const cT = [];
    for (let i = 0; i < N; i++) cT.push(rows.reduce((s, r) => (r[i + 2] ? s + r[1] : s), 0));
    const mT = Math.max(...cT, 1);
    const W = 2200, H = 520;
    const mg = { t: 48, b: 14, l: 100, r: 120 };
    const aH = H - mg.t - mg.b, cG = (W - mg.l - mg.r - bW * N) / (N - 1);
    const uH = aH / mT, nP = 4;

    const NP = {}, segs = [];
    for (let si = 0; si < N; si++) {
      const x0 = mg.l + si * (bW + cG), cH = cT[si] * uH, sY = mg.t + (aH - cH) / 2;
      const gr = [];
      sO.forEach((st) => {
        const m = rows.filter((r) => r[si + 2] === st);
        if (!m.length) return;
        const c = m.reduce((s, r) => s + r[1], 0);
        gr.push({ st, c, rows: m });
      });
      const tP = (gr.length - 1) * nP, sc = (cH - tP) / cT[si];
      let y = sY;
      gr.forEach((g) => {
        const h = g.c * sc;
        NP[`${si}|${g.st}`] = { x0, x1: x0 + bW, y0: y, y1: y + h, si, st: g.st, cnt: g.c };
        let sy = y;
        g.rows.forEach((r) => {
          const sh = r[1] * sc;
          segs.push({ si, st: g.st, lab: r[0], w: r[1], y0: sy, y1: sy + sh, x0, x1: x0 + bW });
          sy += sh;
        });
        y += h + nP;
      });
    }

    const LC = {};
    rows.forEach((r) => { for (let i = 0; i < N - 1; i++) { const a = r[i + 2], b = r[i + 3]; if (!a || !b) continue; const k = `${i}|${a}→${i + 1}|${b}`; LC[k] = (LC[k] || 0) + r[1]; } });
    const sOut = {}, tIn = {};
    Object.keys(NP).forEach((k) => { sOut[k] = 0; tIn[k] = 0; });
    const LL = Object.entries(LC).map(([k, v]) => { const [sk, tk] = k.split("→"); return { sk, tk, v, from: sk.split("|")[1], to: tk.split("|")[1] }; })
      .sort((a, b) => { if (a.from === a.to && b.from !== b.to) return -1; if (a.from !== a.to && b.from === b.to) return 1; return sO.indexOf(a.to) - sO.indexOf(b.to); });
    LL.forEach((l) => {
      const s = NP[l.sk], t = NP[l.tk];
      if (!s || !t) { l.skip = 1; return; }
      const ss = (s.y1 - s.y0) / s.cnt, ts = (t.y1 - t.y0) / t.cnt;
      l.th = Math.max(1, Math.min(l.v * ss, l.v * ts));
      l.sy = s.y0 + sOut[l.sk]; l.ty = t.y0 + tIn[l.tk];
      sOut[l.sk] += l.th; tIn[l.tk] += l.th;
    });

    // Build SVG content as innerHTML for performance
    let html = "";
    // Ribbons
    LL.forEach((l) => {
      if (l.skip) return;
      const s = NP[l.sk], t = NP[l.tk], sx = s.x1, tx = t.x0;
      const sy0 = l.sy, sy1 = l.sy + l.th, ty0 = l.ty, ty1 = l.ty + l.th, mx = (sx + tx) / 2;
      html += `<path d="M${sx},${sy0} C${mx},${sy0} ${mx},${ty0} ${tx},${ty0} L${tx},${ty1} C${mx},${ty1} ${mx},${sy1} ${sx},${sy1} Z" fill="${COLORS[l.to] || "#999"}" fill-opacity="0.14" stroke="${COLORS[l.to] || "#999"}" stroke-width="0.4" stroke-opacity="0.08"/>`;
    });
    // Bars
    Object.values(NP).forEach((n) => {
      html += `<rect x="${n.x0}" y="${n.y0}" width="${bW}" height="${Math.max(2, n.y1 - n.y0)}" rx="3" fill="${COLORS[n.st] || "#999"}"/>`;
    });
    // Status labels
    Object.values(NP).forEach((n) => {
      const h = n.y1 - n.y0;
      if (h < 12) return;
      html += `<text x="${n.x1 + 8}" y="${n.y0 + 2}" dy=".8em" font-size="13" font-weight="500" fill="#444">${n.st}</text>`;
      if (h >= 26) {
        const pct = Math.round(n.cnt / cT[n.si] * 100);
        html += `<text x="${n.x1 + 8}" y="${n.y0 + 17}" dy=".8em" font-size="11" fill="#aaa">${n.cnt} · ${pct}%</text>`;
      }
    });
    // Company labels
    const uY = {};
    segs.forEach((seg) => {
      const h = seg.y1 - seg.y0; if (h < 6) return;
      const midY = (seg.y0 + seg.y1) / 2, fs = h > 16 ? 12 : h > 10 ? 10 : 8;
      const lh = fs + 2, ly0 = midY - lh / 2, ly1 = midY + lh / 2;
      const col = seg.si + "|" + seg.st;
      if (!uY[col]) uY[col] = [];
      if (uY[col].some((a) => !(ly1 < a[0] || ly0 > a[1]))) return;
      uY[col].push([ly0, ly1]);
      const lab = seg.w > 1 ? `${seg.lab} ×${seg.w}` : seg.lab;
      html += `<text x="${seg.x0 - 6}" y="${midY}" dy="0.35em" text-anchor="end" font-size="${fs}" fill="#888">${lab}</text>`;
    });
    // Date headers
    steps.forEach((l, i) => {
      const x = mg.l + i * (bW + cG) + bW / 2;
      html += `<text x="${x}" y="${mg.t - 14}" text-anchor="middle" font-size="14" font-weight="500" fill="#555">${l}</text>`;
      html += `<text x="${x}" y="${mg.t - 1}" text-anchor="middle" font-size="10" fill="#bbb">${cT[i]}</text>`;
    });
    // Title
    const total = rows.reduce((s, r) => s + r[1], 0);
    html += `<text x="${W / 2}" y="16" text-anchor="middle" font-size="16" font-weight="500" fill="#333">${title} · ${total} total</text>`;

    svg.innerHTML = html;
  }, [steps, rows, title]);

  return (
    <svg
      ref={ref}
      viewBox="0 0 2200 520"
      style={{ width: "100%", display: "block", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}
    />
  );
}

export default function App() {
  const [hangData, setHangData] = useState(null);
  const [tongData, setTongData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [hangRaw, tongRaw] = await Promise.all([
        fetchNotionData(HANG_DS, "Hang"),
        fetchNotionData(TONG_DS, "Tong"),
      ]);
      setHangData(processData(hangRaw));
      setTongData(processData(tongRaw));
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1rem 0.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>Internship Application Journey</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {lastUpdated && <span style={{ fontSize: 12, color: "#aaa" }}>Updated {lastUpdated}</span>}
          <button
            onClick={loadData}
            disabled={loading}
            style={{
              padding: "6px 16px", borderRadius: 8, border: "1px solid #ddd",
              background: loading ? "#f5f5f5" : "#fff", cursor: loading ? "wait" : "pointer",
              fontSize: 13, fontWeight: 500,
            }}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: 16, background: "#FEF2F2", borderRadius: 8, color: "#991B1B", marginBottom: 16, fontSize: 13 }}>
          Error: {error}
        </div>
      )}

      {loading && !hangData && (
        <div style={{ textAlign: "center", padding: 60, color: "#999" }}>
          <div style={{ fontSize: 14, marginBottom: 8 }}>Fetching data from Notion…</div>
          <div style={{ fontSize: 12, color: "#bbb" }}>This may take a few seconds</div>
        </div>
      )}

      {hangData && hangData.rows.length > 0 && (
        <SankeyChart title="Hang's internship journey" steps={hangData.steps} rows={hangData.rows} />
      )}

      {hangData && tongData && <div style={{ height: 1, background: "rgba(0,0,0,0.06)", margin: "24px 0" }} />}

      {tongData && tongData.rows.length > 0 && (
        <SankeyChart title="Tong's internship journey" steps={tongData.steps} rows={tongData.rows} />
      )}

      {hangData && hangData.rows.length === 0 && tongData && tongData.rows.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "#999", fontSize: 14 }}>
          No data found. Make sure the Notion databases are accessible.
        </div>
      )}
    </div>
  );
}
