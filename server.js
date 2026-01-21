// server.js (완성본: tick 저장 + OHLC 캔들 API + reserves JSON 제공 + market/today + analysis)
// 실행: node ./server.js

const express = require("express");
const cheerio = require("cheerio");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// ✅ OpenAI Node SDK
// package.json에 "openai" dependency 필요
const { OpenAI } = require("openai"); // npm package: "openai" [Source](https://www.npmjs.com/package/openai)

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
  // "10s", "1m", "30m", "2h"
  const m = String(interval || "30m").match(/^(\d+)([smh])$/);
  if (!m) return 30 * 60 * 1000;
  const n = parseInt(m[1], 10);
  if (m[2] === "s") return n * 1000;
  if (m[2] === "m") return n * 60 * 1000;
  return n * 60 * 60 * 1000;
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

/** ---------- /api/analysis 캐시(2시간) ---------- */
const ANALYSIS_TTL_MS = 2 * 60 * 60 * 1000; // 2h
const analysisCache = new Map(); // key: symbol, value: { ts, payload }

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

// ✅ DXY (네이버)
async function crawlInvestingDXY() {
  const url = "https://m.stock.naver.com/marketindex/exchange/.DXY";
  const html = await fetchText(url, { "Referer": "https://m.stock.naver.com/" });
  const $ = cheerio.load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  let m = bodyText.match(/달러인덱스\s*([0-9]{2,3}(?:\.[0-9]+)?)/);

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

/** ---------- 공통: OHLC ---------- */
function getCandles(symbol, interval, range) {
  const bucketMs = intervalToMs(interval);
  const end = nowMs();
  const start = end - parseRangeToMs(range);
  const rows = selectTicks.all(symbol, start, end);

  const map = new Map();
  for (const r of rows) {
    const b = bucketStart(r.ts, bucketMs);
    const v = r.value;
    if (!map.has(b)) map.set(b, { t: b, o: v, h: v, l: v, c: v });
    else {
      const x = map.get(b);
      x.h = Math.max(x.h, v);
      x.l = Math.min(x.l, v);
      x.c = v;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.t - b.t);
}

/** ---------- API ---------- */
app.get("/api/latest", (req, res) => res.json(state));

app.get("/api/candles", (req, res) => {
  const symbol = String(req.query.symbol || "USDKRW").toUpperCase();
  const interval = String(req.query.interval || "30m");
  const range = String(req.query.range || "7d");
  res.json(getCandles(symbol, interval, range));
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

/**
 * ✅ /api/market/today
 * - 네이버 금융 주요뉴스 텍스트 기반 크롤링
 * - Source: https://finance.naver.com/news/mainnews.naver [Source](https://finance.naver.com/news/mainnews.naver)
 */
app.get("/api/market/today", async (req, res) => {
  try {
    const url = "https://finance.naver.com/news/mainnews.naver";
    const html = await fetchText(url, { "Referer": "https://finance.naver.com/" });
    const $ = cheerio.load(html);

    const items = [];
    $("a").each((_, el) => {
      const href = $(el).attr("href") || "";
      const title = $(el).text().replace(/\s+/g, " ").trim();
      if (!title) return;

      if (href.includes("news_read.naver")) {
        const link = href.startsWith("http") ? href : `https://finance.naver.com${href}`;
        items.push({ title, link });
      }
    });

    const uniq = [];
    const seen = new Set();
    for (const it of items) {
      if (seen.has(it.link)) continue;
      seen.add(it.link);
      uniq.push(it);
      if (uniq.length >= 8) break;
    }

    res.json({
      asofKST: kstNowString(),
      source: url,
      headlines: uniq
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * ✅ /api/analysis (LLM 문장 생성) + 2시간 캐시 + 429 폴백
 * - 입력: ?symbol=USDKRW|EURKRW (기본 USDKRW)
 * - 데이터: 최신 KPI(state) + 1분봉(24h) + 30분봉(7d) + 오늘의 증시(네이버)
 * - OpenAI KEY: process.env.OPENAI_API_KEY
 * - 429 Rate limit이면 캐시가 있으면 캐시 반환(200), 없으면 안내문 반환(200)
 */
app.get("/api/analysis", async (req, res) => {
  const symbol = String(req.query.symbol || "USDKRW").toUpperCase();
  const now = Date.now();

  // 0) 캐시 히트
  const cached = analysisCache.get(symbol);
  if (cached && (now - cached.ts) < ANALYSIS_TTL_MS) {
    return res.status(200).json({
      ...cached.payload,
      cached: true,
      cacheAgeSec: Math.floor((now - cached.ts) / 1000),
    });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      // 키 없을 때도 200으로 안내(프론트 NO-LLM 방지)
      return res.status(200).json({
        asofKST: kstNowString(),
        symbol,
        analysis: "OPENAI_API_KEY가 설정되어 있지 않아 분석을 생성할 수 없습니다.",
        degraded: true
      });
    }

    const latest = state;
    const candles1m = getCandles(symbol, "1m", "24h");
    const candles30m = getCandles(symbol, "30m", "7d");

    function summarizeCandles(cs) {
      if (!cs || cs.length < 2) return { n: cs?.length || 0 };
      const first = cs[0].o;
      const last = cs[cs.length - 1].c;
      let hi = -Infinity, lo = Infinity;
      for (const x of cs) { hi = Math.max(hi, x.h); lo = Math.min(lo, x.l); }
      const chg = last - first;
      const chgPct = first ? (chg / first) * 100 : null;
      return {
        n: cs.length,
        first, last,
        hi, lo,
        chg: +chg.toFixed(4),
        chgPct: chgPct == null ? null : +chgPct.toFixed(3)
      };
    }

    // 오늘의 증시(간단히 5개)
    const market = await (async () => {
      const url = "https://finance.naver.com/news/mainnews.naver";
      const html = await fetchText(url, { "Referer": "https://finance.naver.com/" });
      const $ = cheerio.load(html);
      const items = [];
      $("a").each((_, el) => {
        const href = $(el).attr("href") || "";
        const title = $(el).text().replace(/\s+/g, " ").trim();
        if (!title) return;
        if (href.includes("news_read.naver")) {
          const link = href.startsWith("http") ? href : `https://finance.naver.com${href}`;
          items.push({ title, link });
        }
      });
      const uniq = [];
      const seen = new Set();
      for (const it of items) {
        if (seen.has(it.link)) continue;
        seen.add(it.link);
        uniq.push(it);
        if (uniq.length >= 5) break;
      }
      return { source: url, headlines: uniq };
    })();

    const s1 = summarizeCandles(candles1m);
    const s7 = summarizeCandles(candles30m);

    const prompt = `
너는 한국 거주 개인의 "환율 매입 관점" 조언을 하는 애널리스트다.
아래 데이터만 근거로, 과장 없이 '오늘 매입 판단'을 한국어로 작성해라.
반드시 포함:
- (1) 24시간/7일 요약(변동률, 고점/저점)
- (2) 현재 레벨(USDKRW/EURKRW, DXY, 금리, 스프레드)
- (3) 오늘 시장 헤드라인이 주는 리스크/심리
- (4) "지금 당장 매입 vs 분할매수 vs 대기" 중 하나를 결론으로, 근거 3개
- (5) 마지막 줄에 면책: "투자 조언이 아님"

[현재 KPI]
asofKST=${latest.asofKST}
USDKRW=${latest.usdkrw}
EURKRW=${latest.eurkrw}
DXY=${latest.dxy}
KR10Y=${latest.kr10y}
US10Y=${latest.us10y}
SPREAD10Y=${latest.spread10y}

[${symbol} 24h 요약(1m)]
${JSON.stringify(s1)}

[${symbol} 7d 요약(30m)]
${JSON.stringify(s7)}

[오늘의 증시 주요뉴스(네이버)]
${market.headlines.map((h,i)=>`${i+1}. ${h.title}`).join("\n")}
`.trim();

    const client = new OpenAI({ apiKey });

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "너는 금융 데이터 요약에 강한 한국어 애널리스트다." },
        { role: "user", content: prompt }
      ],
      temperature: 0.4
    });

    const text = completion?.choices?.[0]?.message?.content?.trim() || "";

    const payload = {
      asofKST: kstNowString(),
      symbol,
      inputs: {
        latest,
        summary24h_1m: s1,
        summary7d_30m: s7,
        marketToday: market
      },
      analysis: text
    };

    // 1) 성공하면 캐시 저장
    analysisCache.set(symbol, { ts: now, payload });

    return res.status(200).json({ ...payload, cached: false });

  } catch (e) {
    const msg = String(e?.message || e);
    const isRateLimit = msg.includes("429") || msg.toLowerCase().includes("rate limit");

    if (isRateLimit) {
      const cached2 = analysisCache.get(symbol);
      if (cached2) {
        return res.status(200).json({
          ...cached2.payload,
          cached: true,
          degraded: true,
          warning: "OpenAI rate-limited; serving cached analysis (2h TTL)."
        });
      }
      return res.status(200).json({
        asofKST: kstNowString(),
        symbol,
        analysis: "현재 OpenAI 요청 한도(RPM)에 걸려 분석을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        degraded: true,
        warning: "OpenAI rate-limited; no cache available yet."
      });
    }

    // 기타 오류도 200으로 폴백(프론트 안정)
    return res.status(200).json({
      asofKST: kstNowString(),
      symbol,
      analysis: "현재 분석 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
      degraded: true,
      error: msg
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});







