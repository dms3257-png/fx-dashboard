// ─────────────────────────────────────────────────────────────────────────────
// FX Dashboard Server
// ─────────────────────────────────────────────────────────────────────────────
// 기능:
//  - SQLite로 tick 저장 (USDKRW, EURKRW, DXY, KR10Y, US10Y)
//  - OHLC 캔들 API 제공
//  - 외화보유액 JSON 제공
//  - 오늘의 시장 뉴스 헤드라인 크롤링
//  - OpenAI 기반 시황 분석 (캐시 12시간, 쿨다운 5분)
//  - 외국인 주식 매매 동향 크롤링 (네이버 금융)
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────────────────────────────────────
// SQLite DB 초기화
// ─────────────────────────────────────────────────────────────────────────────
const db = new Database("data.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS ticks (
    ts INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    value REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ticks_symbol_ts ON ticks(symbol, ts);
`);

// ─────────────────────────────────────────────────────────────────────────────
// 상태 변수
// ─────────────────────────────────────────────────────────────────────────────
let state = {
  USDKRW: null,
  EURKRW: null,
  DXY: null,
  KR10Y: null,
  US10Y: null,
  spread10y: null,
  asofKST: "",
  errors: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// 시간 유틸리티
// ─────────────────────────────────────────────────────────────────────────────
function nowMs() {
  return Date.now();
}
function kstNowString() {
  const d = new Date();
  return d.toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).replace("T", " ");
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI 분석 설정 (캐시 12시간, 쿨다운 5분)
// ─────────────────────────────────────────────────────────────────────────────
const ANALYSIS_TTL_MS = 12 * 60 * 60 * 1000; // 12시간
const ANALYSIS_COOLDOWN_MS = 5 * 60 * 1000;  // 5분

const analysisCache = new Map();
let lastAnalysisTime = 0;

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ─────────────────────────────────────────────────────────────────────────────
// 크롤링: 네이버 환율 (USDKRW, EURKRW)
// ─────────────────────────────────────────────────────────────────────────────
async function crawlNaverFx() {
  try {
    const urlUSD = "https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_USDKRW";
    const urlEUR = "https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_EURKRW";
    
    const [textUSD, textEUR] = await Promise.all([
      fetchText(urlUSD),
      fetchText(urlEUR)
    ]);
    
    const $usd = cheerio.load(textUSD);
    const $eur = cheerio.load(textEUR);
    
    const usdVal = parseFloat($usd(".no_today .no_up").first().text().replace(/,/g, ""));
    const eurVal = parseFloat($eur(".no_today .no_up").first().text().replace(/,/g, ""));
    
    if (!isNaN(usdVal)) state.USDKRW = usdVal;
    if (!isNaN(eurVal)) state.EURKRW = eurVal;
    
    return { USDKRW: usdVal, EURKRW: eurVal };
  } catch (err) {
    console.error("❌ crawlNaverFx error:", err.message);
    state.errors.push("USDKRW/EURKRW 크롤링 실패");
    return { USDKRW: null, EURKRW: null };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 크롤링: 네이버 국채 (KR10Y, US10Y)
// ─────────────────────────────────────────────────────────────────────────────
async function crawlNaverBond() {
  try {
    const urlKR = "https://finance.naver.com/marketindex/interestDailyQuote.naver?marketindexCd=IRR_GOVT10Y_KR";
    const urlUS = "https://finance.naver.com/marketindex/interestDailyQuote.naver?marketindexCd=IRR_GOVT10Y_US";
    
    const [textKR, textUS] = await Promise.all([
      fetchText(urlKR),
      fetchText(urlUS)
    ]);
    
    const $kr = cheerio.load(textKR);
    const $us = cheerio.load(textUS);
    
    const krVal = parseFloat($kr(".num").first().text().replace(/,/g, ""));
    const usVal = parseFloat($us(".num").first().text().replace(/,/g, ""));
    
    if (!isNaN(krVal)) state.KR10Y = krVal;
    if (!isNaN(usVal)) state.US10Y = usVal;
    if (!isNaN(krVal) && !isNaN(usVal)) {
      state.spread10y = (usVal - krVal).toFixed(2);
    }
    
    return { KR10Y: krVal, US10Y: usVal };
  } catch (err) {
    console.error("❌ crawlNaverBond error:", err.message);
    state.errors.push("KR10Y/US10Y 크롤링 실패");
    return { KR10Y: null, US10Y: null };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 크롤링: Investing.com DXY
// ─────────────────────────────────────────────────────────────────────────────
async function crawlInvestingDXY() {
  try {
    const url = "https://www.investing.com/indices/usdollar";
    const text = await fetchText(url);
    const $ = cheerio.load(text);
    const dxyText = $("[data-test='instrument-price-last']").first().text().trim().replace(/,/g, "");
    const dxy = parseFloat(dxyText);
    if (!isNaN(dxy)) {
      state.DXY = dxy;
      return dxy;
    }
    throw new Error("DXY 파싱 실패");
  } catch (err) {
    console.error("❌ crawlInvestingDXY error:", err.message);
    state.errors.push("DXY 크롤링 실패");
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 공통 fetch (인코딩 자동 감지)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "";
  const match = contentType.match(/charset=([^;]+)/i);
  const charset = match ? match[1].trim() : "utf-8";
  
  try {
    return iconv.decode(buf, charset);
  } catch {
    return iconv.decode(buf, "utf-8");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB 저장
// ─────────────────────────────────────────────────────────────────────────────
function saveTicks(ts, data) {
  const stmt = db.prepare("INSERT INTO ticks (ts, symbol, value) VALUES (?, ?, ?)");
  const insertMany = db.transaction((rows) => {
    for (const r of rows) stmt.run(r);
  });
  
  const rows = [];
  if (data.USDKRW) rows.push([ts, "USDKRW", data.USDKRW]);
  if (data.EURKRW) rows.push([ts, "EURKRW", data.EURKRW]);
  if (data.DXY) rows.push([ts, "DXY", data.DXY]);
  if (data.KR10Y) rows.push([ts, "KR10Y", data.KR10Y]);
  if (data.US10Y) rows.push([ts, "US10Y", data.US10Y]);
  
  if (rows.length > 0) insertMany(rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// 주기적 데이터 수집 (10초마다)
// ─────────────────────────────────────────────────────────────────────────────
async function collectData() {
  state.errors = [];
  const ts = Math.floor(nowMs() / 1000);
  
  const [fx, bond, dxy] = await Promise.all([
    crawlNaverFx(),
    crawlNaverBond(),
    crawlInvestingDXY()
  ]);
  
  state.asofKST = kstNowString();
  saveTicks(ts, { ...fx, ...bond, DXY: dxy });
}

setInterval(collectData, 10000);
collectData();

// ─────────────────────────────────────────────────────────────────────────────
// OHLC 캔들 생성
// ─────────────────────────────────────────────────────────────────────────────
function parseRangeToMs(range) {
  const m = range.match(/^(\d+)([mhd])$/);
  if (!m) return 24 * 3600 * 1000;
  const [, n, unit] = m;
  const val = parseInt(n, 10);
  if (unit === "m") return val * 60 * 1000;
  if (unit === "h") return val * 3600 * 1000;
  if (unit === "d") return val * 24 * 3600 * 1000;
  return 24 * 3600 * 1000;
}

function intervalToMs(interval) {
  const m = interval.match(/^(\d+)([mh])$/);
  if (!m) return 60000;
  const [, n, unit] = m;
  const val = parseInt(n, 10);
  return unit === "m" ? val * 60000 : val * 3600000;
}

function bucketStart(ts, bucketMs) {
  return Math.floor(ts / bucketMs) * bucketMs;
}

function getCandles(symbol, interval, range) {
  const rangeMs = parseRangeToMs(range);
  const bucketMs = intervalToMs(interval);
  const now = nowMs();
  const startTime = now - rangeMs;
  
  const rows = db
    .prepare("SELECT ts, value FROM ticks WHERE symbol = ? AND ts >= ? ORDER BY ts ASC")
    .all(symbol, Math.floor(startTime / 1000));
  
  const buckets = new Map();
  for (const { ts, value } of rows) {
    const bucket = bucketStart(ts * 1000, bucketMs);
    if (!buckets.has(bucket)) {
      buckets.set(bucket, { open: value, high: value, low: value, close: value });
    } else {
      const b = buckets.get(bucket);
      b.high = Math.max(b.high, value);
      b.low = Math.min(b.low, value);
      b.close = value;
    }
  }
  
  return Array.from(buckets.entries())
    .map(([time, ohlc]) => ({ time: Math.floor(time / 1000), ...ohlc }))
    .sort((a, b) => a.time - b.time);
}

// ─────────────────────────────────────────────────────────────────────────────
// API: /api/latest
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/latest", (req, res) => {
  res.json(state);
});

// ─────────────────────────────────────────────────────────────────────────────
// API: /api/candles
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/candles", (req, res) => {
  const { symbol = "USDKRW", interval = "1m", range = "24h" } = req.query;
  const candles = getCandles(symbol, interval, range);
  res.json({ symbol, interval, range, candles });
});

// ─────────────────────────────────────────────────────────────────────────────
// API: /api/reserves (외화보유액 JSON 제공)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/reserves", (req, res) => {
  const filePath = path.join(__dirname, "public", "data", "reserves.json");
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "reserves.json not found" });
  }
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  res.json(data);
});

// ─────────────────────────────────────────────────────────────────────────────
// API: /api/market/today (오늘의 뉴스 헤드라인)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/market/today", async (req, res) => {
  try {
    const url = "https://finance.naver.com/news/news_list.naver?mode=LSS2D&section_id=101&section_id2=258";
    const text = await fetchText(url);
    const $ = cheerio.load(text);
    const headlines = [];
    
    $(".newsList .articleSubject a").each((i, el) => {
      if (i >= 5) return false;
      const title = $(el).text().trim();
      const link = $(el).attr("href");
      if (title && link) {
        headlines.push({ title, link: `https://finance.naver.com${link}` });
      }
    });
    
    res.json({ headlines, asofKST: kstNowString() });
  } catch (err) {
    console.error("❌ /api/market/today error:", err.message);
    res.status(500).json({ error: "뉴스 크롤링 실패" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: /api/analysis (OpenAI 분석, 캐시 12시간, 쿨다운 5분)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/analysis", async (req, res) => {
  const symbol = req.query.symbol || "USDKRW";
  const cacheKey = `analysis_${symbol}`;
  const now = Date.now();
  
  // 캐시 확인
  const cached = analysisCache.get(cacheKey);
  if (cached && now - cached.timestamp < ANALYSIS_TTL_MS) {
    return res.json(cached.data);
  }
  
  // 쿨다운 확인
  if (now - lastAnalysisTime < ANALYSIS_COOLDOWN_MS) {
    const waitSec = Math.ceil((ANALYSIS_COOLDOWN_MS - (now - lastAnalysisTime)) / 1000);
    return res.status(429).json({
      error: `AI 분석은 ${waitSec}초 후에 다시 요청할 수 있습니다.`,
      retryAfter: waitSec
    });
  }
  
  if (!openai) {
    return res.status(503).json({ error: "OpenAI API 키가 설정되지 않았습니다." });
  }
  
  try {
    lastAnalysisTime = now;
    
    const candles = getCandles(symbol, "1h", "7d");
    const latest = state[symbol] || 0;
    const weekAgo = candles[0]?.close || latest;
    const change = ((latest - weekAgo) / weekAgo * 100).toFixed(2);
    
    const prompt = `다음은 ${symbol}의 최근 7일간 1시간 봉 데이터입니다:
${JSON.stringify(candles.slice(-24), null, 2)}

현재 ${symbol}: ${latest}
7일 전 대비: ${change}%

한국 투자자를 위해 200자 이내로 간결하게 분석해주세요:
- 주요 변동 원인
- 단기 전망
- 투자자 유의사항`;
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 500
    });
    
    const analysis = completion.choices[0].message.content.trim();
    const result = {
      symbol,
      analysis,
      asofKST: kstNowString(),
      cachedUntil: new Date(now + ANALYSIS_TTL_MS).toISOString()
    };
    
    analysisCache.set(cacheKey, { data: result, timestamp: now });
    res.json(result);
    
  } catch (err) {
    console.error("❌ /api/analysis error:", err.message);
    
    if (err.status === 429) {
      return res.status(429).json({
        error: "OpenAI API 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.",
        retryAfter: 300
      });
    }
    
    res.status(500).json({ error: "AI 분석 생성 실패" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: /api/foreign-flows (네이버 금융 외국인 주식 매매 동향)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/foreign-flows", async (req, res) => {
  try {
    const today = new Date();
    const bizdate = today.toISOString().slice(0, 10).replace(/-/g, "");
    const url = `https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=${bizdate}&sosok=&page=1`;
    
    const text = await fetchText(url);
    const $ = cheerio.load(text);
    
    const rows = [];
    $("table.type_1 tr").each((i, row) => {
      if (i === 0) return; // 헤더 스킵
      const cols = $(row).find("td");
      if (cols.length < 4) return;
      
      const dateText = $(cols[0]).text().trim();
      const foreignText = $(cols[2]).text().trim().replace(/,/g, "");
      
      if (dateText && foreignText && !isNaN(parseFloat(foreignText))) {
        const date = new Date(dateText.replace(/\./g, "-"));
        const net = parseFloat(foreignText) * 100000000; // 억원 -> 원
        rows.push({ time: Math.floor(date.getTime() / 1000), net });
      }
    });
    
    if (rows.length === 0) throw new Error("데이터 파싱 실패");
    
    rows.sort((a, b) => a.time - b.time);
    
    const todayNet = rows[rows.length - 1]?.net || 0;
    const last7d = rows.slice(-7);
    const last7dNet = last7d.reduce((sum, r) => sum + r.net, 0);
    
    res.json({
      today: {
        netBuy: todayNet > 0 ? todayNet : 0,
        netSell: todayNet < 0 ? todayNet : 0
      },
      last7d: {
        netBuy: last7dNet > 0 ? last7dNet : 0,
        netSell: last7dNet < 0 ? last7dNet : 0
      },
      series: rows,
      asofKST: kstNowString(),
      source: "네이버 증권 - 투자자별 매매동향",
      note: "주식시장 외국인 매매 데이터 (외환 매매 아님)"
    });
    
  } catch (err) {
    console.error("❌ /api/foreign-flows error:", err.message);
    
    // 실패 시 Mock 데이터 반환
    const mockSeries = Array.from({ length: 30 }, (_, i) => ({
      time: Math.floor((Date.now() - (29 - i) * 86400000) / 1000),
      net: Math.floor(Math.random() * 1000000000) - 500000000
    }));
    
    res.json({
      today: { netBuy: 0, netSell: 0 },
      last7d: { netBuy: 0, netSell: 0 },
      series: mockSeries,
      asofKST: kstNowString(),
      source: "Mock Data (크롤링 실패)",
      note: "실제 데이터 수집 실패, 임시 데이터"
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 정적 파일 & 기본 라우트
// ─────────────────────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
