// server.js (완성본: tick 저장 + OHLC 캔들 API + reserves JSON 제공)
// 실행: node .\server.js

const express = require("express");
const cheerio = require("cheerio");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const app = express();
app.use(cors());
app.use(express.static("public"));

/** ---------- 시간 유틸 ---------- */
function nowMs() { return Date.now(); }
function kstNowString() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth()+1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())} KST`;
}
function parseRangeToMs(range) {
  // "7d", "30d", "24h" 지원
  const m = String(range || "7d").match(/^(\d+)([dh])$/);
  if (!m) return 7 * 24 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  return m[2] === "d" ? n * 24 * 60 * 60 * 1000 : n * 60 * 60 * 1000;
}
function intervalToMs(interval) {
  // "30m", "2h"
  const m = String(interval || "30m").match(/^(\d+)([mh])$/);
  if (!m) return 30 * 60 * 1000;
  const n = parseInt(m[1], 10);
  return m[2] === "m" ? n * 60 * 1000 : n * 60 * 60 * 1000;
}
function bucketStart(ts, bucketMs) {
  return Math.floor(ts / bucketMs) * bucketMs;
}


/** ---------- DB (SQLite) ---------- */
const db = new Database("data.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS ticks (
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  value REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticks_symbol_ts ON ticks(symbol, ts);
`);

const insertTick = db.prepare("INSERT INTO ticks (ts, symbol, value) VALUES (?, ?, ?)");
const selectTicks = db.prepare("SELECT ts, value FROM ticks WHERE symbol=? AND ts>=? AND ts<=? ORDER BY ts ASC");


/** ---------- 상태 ---------- */
const state = {
  asofKST: null,
  status: "BOOT",
  usdkrw: null, eurkrw: null, dxy: null,
  kr10y: null, us10y: null,
  spread10y: null,
  errors: []
};


/** ---------- HTTP fetch ---------- */
async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      ...headers
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}


/** ---------- 크롤러 ---------- */
async function crawlNaverFx() {
  const url = "https://finance.naver.com/marketindex/";
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  let usd = null, eur = null;

  $("tr, li").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (!usd && /USD/.test(t)) {
      const m = t.match(/([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?)/);
      if (m) usd = parseFloat(m[1].replace(/,/g, ""));
    }
    if (!eur && /EUR/.test(t)) {
      const m = t.match(/([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?)/);
      if (m) eur = parseFloat(m[1].replace(/,/g, ""));
    }
  });

  if (!usd && !eur) throw new Error("Naver FX parse failed");
  return { usdkrw: usd, eurkrw: eur, source: url };
}

async function crawlNaverBond(url) {
  const html = await fetchText(url);
  const text = cheerio.load(html)("body").text().replace(/\s+/g, " ").trim();
  const m = text.match(/([0-9]\.[0-9]{3,4})/);
  if (!m) throw new Error(`Bond parse failed: ${url}`);
  return parseFloat(m[1]);
}

/**
 * ✅ DXY 크롤링 (Investing → 네이버로 교체)
 * - 기존 Investing: Render에서 HTTP 403으로 자주 실패 [Source](https://fx-dashboard-2zo3.onrender.com/api/latest)
 * - 네이버: HTML에 값이 그대로 내려옴(예: 98.87) [Source](https://m.stock.naver.com/marketindex/exchange/.DXY)
 *
 * "최소 수정"을 위해 함수명은 crawlInvestingDXY 그대로 유지합니다.
 */
async function crawlInvestingDXY() {
  const url = "https://m.stock.naver.com/marketindex/exchange/.DXY";
  const html = await fetchText(url, {
    "Referer": "https://m.stock.naver.com/",
  });

  const $ = cheerio.load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  // 1) 가장 안정적인 패턴: "달러인덱스" 뒤에 나오는 첫 숫자
  // (페이지에 "달러인덱스" + 굵은 숫자가 내려오는 것이 확인됨) [Source](https://m.stock.naver.com/marketindex/exchange/.DXY)
  let m = bodyText.match(/달러인덱스\s*([0-9]{2,3}(?:\.[0-9]+)?)/);

  // 2) fallback: 텍스트 안에서 60~200 사이 숫자 하나 찾기
  if (!m) {
    const candidates = [];
    const tokens = bodyText.replace(/[^\d.]/g, " ").split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      if (/^[0-9]{2,3}(\.[0-9]+)?$/.test(t)) {
        const x = parseFloat(t);
        if (x > 60 && x < 200) candidates.push(x);
      }
    }
    if (!candidates.length) throw new Error("Naver DXY parse failed");
    return candidates[0];
  }

  return parseFloat(m[1]);
}


/** ---------- 데이터 수집 + tick 저장 ---------- */
function saveTicks(ts, map) {
  const tx = db.transaction((pairs) => {
    for (const [symbol, value] of pairs) {
      if (typeof value === "number" && Number.isFinite(value)) {
        insertTick.run(ts, symbol, value);
      }
    }
  });
  tx(Object.entries(map));
}

async function refresh() {
  const errors = [];
  let status = "OK";

  try {
    const fx = await crawlNaverFx();
    if (typeof fx.usdkrw === "number") state.usdkrw = fx.usdkrw;
    if (typeof fx.eurkrw === "number") state.eurkrw = fx.eurkrw;
  } catch (e) { errors.push(String(e.message||e)); status = "WARN"; }

  try {
    state.kr10y = await crawlNaverBond("https://m.stock.naver.com/marketindex/bond/KR10YT=RR");
  } catch (e) { errors.push(String(e.message||e)); status = "WARN"; }

  try {
    state.us10y = await crawlNaverBond("https://m.stock.naver.com/marketindex/bond/US10YT=RR");
  } catch (e) { errors.push(String(e.message||e)); status = "WARN"; }

  try {
    state.dxy = await crawlInvestingDXY();
  } catch (e) {
    errors.push(String(e.message||e));
    status = (status === "OK") ? "WARN" : status;
  }

  if (typeof state.us10y === "number" && typeof state.kr10y === "number") {
    state.spread10y = +(state.us10y - state.kr10y).toFixed(3);
  }

  const ts = nowMs();
  state.asofKST = kstNowString();
  state.status = status;
  state.errors = errors.slice(0, 6);

  // tick 저장(차트용 원천 데이터)
  saveTicks(ts, {
    USDKRW: state.usdkrw,
    EURKRW: state.eurkrw,
    DXY: state.dxy,
    KR10Y: state.kr10y,
    US10Y: state.us10y,
    SPREAD10Y: state.spread10y
  });
}

setInterval(refresh, 10_000);
refresh();


/** ---------- API ---------- */
app.get("/api/latest", (req, res) => res.json(state));

app.get("/api/candles", (req, res) => {
  const symbol = String(req.query.symbol || "USDKRW").toUpperCase();
  const interval = String(req.query.interval || "30m");
  const range = String(req.query.range || "7d");

  const bucketMs = intervalToMs(interval);
  const end = nowMs();
  const start = end - parseRangeToMs(range);

  const rows = selectTicks.all(symbol, start, end); // [{ts,value},...]

  // OHLC 집계
  const map = new Map();
  for (const r of rows) {
    const b = bucketStart(r.ts, bucketMs);
    const v = r.value;
    if (!map.has(b)) {
      map.set(b, { t: b, o: v, h: v, l: v, c: v });
    } else {
      const x = map.get(b);
      x.h = Math.max(x.h, v);
      x.l = Math.min(x.l, v);
      x.c = v;
    }
  }
  const out = Array.from(map.values()).sort((a,b)=>a.t-b.t);
  res.json(out);
});

app.get("/api/reserves", (req, res) => {
  const p = path.join(__dirname, "public", "data", "reserves.json");
  try {
    const raw = fs.readFileSync(p, "utf-8");
    res.type("json").send(raw);
  } catch (e) {
    res.status(404).json({ error: "reserves.json not found", hint: "Create public/data/reserves.json" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});




