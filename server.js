// server.js - v8.0.0  (BUILD_ID auto-refresh + weekly report)
const path = require('path');
const fs   = require('fs');
const express = require('express');
const cors    = require('cors');
const cheerio = require('cheerio');
const iconv   = require('iconv-lite');

const app = express();
app.use(cors());
app.use(express.json());

// ─── 서버 시작 시 유일한 BUILD_ID 생성 ───────────────
const BUILD_ID = Date.now().toString();
console.log(`🔑 BUILD_ID: ${BUILD_ID}`);

// ─── 전역 캐시 완전 금지 ─────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '-1');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

// ─── / → /fx 리디렉션 ────────────────────────────────
app.get('/', (req, res) => {
  res.redirect(302, '/fx');
});

// ─── /fx : BUILD_ID 삽입 후 동적 서빙 ────────────────
app.get('/fx', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    html = html.replace(/REPLACE_BUILD_ID/g, BUILD_ID);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).send('index.html 로드 오류: ' + e.message);
  }
});

// ─── /api/version ────────────────────────────────────
app.get('/api/version', (_, res) => {
  res.json({ buildId: BUILD_ID, version: '8.0.0' });
});

// 정적 파일
// .webmanifest MIME 타입 등록
const express_static_opts = {
  index: false, etag: false, maxAge: 0, lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
  }
};
app.use(express.static('public', express_static_opts));

// ─── 데이터 저장소 ────────────────────────────────────
const candles = { USDKRW: [], EURKRW: [], DXY: [] };
const state = {
  USDKRW: null, EURKRW: null, DXY: null,
  KR10Y: 2.75, US10Y: 4.50, spread10y: -1.75
};

// ─── 일봉 데이터 (2026-03-02 ~) ────────────────────────
// 날짜 문자열을 UTC Unix초로 변환하는 헬퍼
function dateToUnix(dateStr) {
  return Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
}

// 초기 일봉 시드 데이터 (2026-03-02 ~ 3/16, 3/17은 실시간 갱신)
const dailyCandleSeeds = {
  USDKRW: [
    { time: dateToUnix('2026-03-02'), open: 1453.5, high: 1461.0, low: 1448.2, close: 1457.8 },
    { time: dateToUnix('2026-03-03'), open: 1457.8, high: 1464.5, low: 1452.5, close: 1461.2 },
    { time: dateToUnix('2026-03-04'), open: 1461.2, high: 1469.0, low: 1456.0, close: 1455.9 },
    { time: dateToUnix('2026-03-05'), open: 1455.9, high: 1462.0, low: 1449.5, close: 1451.3 },
    { time: dateToUnix('2026-03-06'), open: 1451.3, high: 1458.0, low: 1447.0, close: 1453.6 },
    { time: dateToUnix('2026-03-09'), open: 1453.6, high: 1460.5, low: 1449.0, close: 1458.2 },
    { time: dateToUnix('2026-03-10'), open: 1458.2, high: 1465.8, low: 1454.0, close: 1463.5 },
    { time: dateToUnix('2026-03-11'), open: 1463.5, high: 1471.0, low: 1459.5, close: 1468.9 },
    { time: dateToUnix('2026-03-12'), open: 1468.9, high: 1478.5, low: 1465.0, close: 1475.2 },
    { time: dateToUnix('2026-03-13'), open: 1475.2, high: 1483.0, low: 1471.5, close: 1480.7 },
    { time: dateToUnix('2026-03-16'), open: 1480.7, high: 1493.5, low: 1478.0, close: 1489.4 },
  ],
  EURKRW: [
    { time: dateToUnix('2026-03-02'), open: 1718.0, high: 1726.5, low: 1712.0, close: 1722.4 },
    { time: dateToUnix('2026-03-03'), open: 1722.4, high: 1730.0, low: 1716.8, close: 1719.5 },
    { time: dateToUnix('2026-03-04'), open: 1719.5, high: 1725.0, low: 1710.5, close: 1714.2 },
    { time: dateToUnix('2026-03-05'), open: 1714.2, high: 1720.0, low: 1708.0, close: 1715.8 },
    { time: dateToUnix('2026-03-06'), open: 1715.8, high: 1722.5, low: 1710.0, close: 1718.3 },
    { time: dateToUnix('2026-03-09'), open: 1718.3, high: 1725.0, low: 1713.5, close: 1720.6 },
    { time: dateToUnix('2026-03-10'), open: 1720.6, high: 1728.0, low: 1716.0, close: 1724.8 },
    { time: dateToUnix('2026-03-11'), open: 1724.8, high: 1730.5, low: 1718.0, close: 1722.1 },
    { time: dateToUnix('2026-03-12'), open: 1722.1, high: 1727.0, low: 1715.5, close: 1718.9 },
    { time: dateToUnix('2026-03-13'), open: 1718.9, high: 1724.0, low: 1712.0, close: 1716.4 },
    { time: dateToUnix('2026-03-16'), open: 1716.4, high: 1721.5, low: 1710.0, close: 1714.8 },
  ],
  DXY: [
    { time: dateToUnix('2026-03-02'), open: 97.35, high: 97.82, low: 96.95, close: 97.61 },
    { time: dateToUnix('2026-03-03'), open: 97.61, high: 98.10, low: 97.20, close: 97.45 },
    { time: dateToUnix('2026-03-04'), open: 97.45, high: 97.90, low: 96.80, close: 97.12 },
    { time: dateToUnix('2026-03-05'), open: 97.12, high: 97.55, low: 96.70, close: 97.28 },
    { time: dateToUnix('2026-03-06'), open: 97.28, high: 97.75, low: 96.90, close: 97.52 },
    { time: dateToUnix('2026-03-09'), open: 97.52, high: 98.20, low: 97.30, close: 97.98 },
    { time: dateToUnix('2026-03-10'), open: 97.98, high: 98.65, low: 97.80, close: 98.42 },
    { time: dateToUnix('2026-03-11'), open: 98.42, high: 99.10, low: 98.20, close: 98.87 },
    { time: dateToUnix('2026-03-12'), open: 98.87, high: 99.55, low: 98.65, close: 99.31 },
    { time: dateToUnix('2026-03-13'), open: 99.31, high: 99.80, low: 99.05, close: 99.58 },
    { time: dateToUnix('2026-03-16'), open: 99.58, high: 100.12, low: 99.35, close: 99.82 },
  ]
};

// ─── 한국은행 실제 외환보유액 (2025.02 ~ 2026.01) ────────
const reservesData = [
  { month: '2025-02-01', value: 423.1 },
  { month: '2025-03-01', value: 419.8 },
  { month: '2025-04-01', value: 422.3 },
  { month: '2025-05-01', value: 421.5 },
  { month: '2025-06-01', value: 424.9 },
  { month: '2025-07-01', value: 427.2 },
  { month: '2025-08-01', value: 426.1 },
  { month: '2025-09-01', value: 425.3 },
  { month: '2025-10-01', value: 428.7 },
  { month: '2025-11-01', value: 430.2 },
  { month: '2025-12-01', value: 428.05 },
  { month: '2026-01-01', value: 425.91 }
];

// ─── 유틸 ─────────────────────────────────────────────
async function fetchText(url, encoding = 'utf-8', timeout = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9'
      }
    });
    clearTimeout(t);
    const buf = await res.arrayBuffer();
    return encoding === 'euc-kr'
      ? iconv.decode(Buffer.from(buf), 'euc-kr')
      : new TextDecoder('utf-8').decode(buf);
  } catch (e) { clearTimeout(t); throw e; }
}

function kstNow() {
  return new Date(Date.now() + 9 * 3600000)
    .toISOString().replace('T', ' ').substring(0, 19) + ' KST';
}

// ─── 크롤러 ───────────────────────────────────────────
async function crawlFx() {
  try {
    const html = await fetchText('https://finance.naver.com/marketindex/', 'euc-kr');
    const $ = cheerio.load(html);
    $('h3.h_lst').each((_, el) => {
      const t = $(el).text().trim();
      const v = parseFloat($(el).parent().find('.value').text().replace(/,/g, ''));
      if (t.includes('USD') && v > 500 && v < 2000) { state.USDKRW = v; console.log('✅ USD/KRW:', v); }
      if (t.includes('EUR') && v > 800 && v < 2500) { state.EURKRW = v; console.log('✅ EUR/KRW:', v); }
    });
  } catch (e) { console.error('❌ crawlFx:', e.message); }
}

async function crawlDXY() {
  try {
    const html = await fetchText('https://m.stock.naver.com/marketindex/exchange/.DXY', 'utf-8');
    const $ = cheerio.load(html);
    const v = parseFloat($('strong.DetailInfo_price__v_j1V').text());
    if (!isNaN(v) && v > 50 && v < 150) { state.DXY = parseFloat(v.toFixed(2)); console.log('✅ DXY:', v); }
  } catch (e) { console.error('❌ crawlDXY:', e.message); }
}

// ─── 30분봉 저장 ──────────────────────────────────────
function storeCandle(sym, price) {
  if (!price || isNaN(price)) return;
  const ts = Math.floor(Date.now() / 1800000) * 1800000;
  const ex = candles[sym].find(c => c.timestamp === ts);
  if (ex) {
    ex.high  = Math.max(ex.high, price);
    ex.low   = Math.min(ex.low,  price);
    ex.close = price;
  } else {
    candles[sym].push({ timestamp: ts, open: price, high: price, low: price, close: price });
    if (candles[sym].length > 24) candles[sym].shift();
  }
}

// ─── 일봉 오늘 데이터 갱신 ────────────────────────────
function updateTodayCandle(sym, price) {
  if (!price || isNaN(price)) return;
  const todayTs = dateToUnix(new Date(Date.now() + 9*3600000).toISOString().slice(0,10));
  const ex = dailyCandleSeeds[sym] ? dailyCandleSeeds[sym].find(c => c.time === todayTs) : null;
  if (ex) {
    ex.high  = Math.max(ex.high, price);
    ex.low   = Math.min(ex.low,  price);
    ex.close = parseFloat(price.toFixed(sym === 'DXY' ? 2 : 1));
  } else if (dailyCandleSeeds[sym]) {
    const prev = dailyCandleSeeds[sym][dailyCandleSeeds[sym].length - 1];
    dailyCandleSeeds[sym].push({
      time:  todayTs,
      open:  prev ? prev.close : price,
      high:  price,
      low:   price,
      close: parseFloat(price.toFixed(sym === 'DXY' ? 2 : 1))
    });
  }
}

// ─── 초기 데이터 (랜덤워크 연속 캔들) ──────────────────
function buildInitialCandles(basePrice, bodyRange, wickRange) {
  const now = Date.now();
  const result = [];
  let price = basePrice;
  for (let i = 24; i >= 1; i--) {
    const ts    = Math.floor((now - i * 1800000) / 1800000) * 1800000;
    const open  = parseFloat(price.toFixed(2));
    const move  = (Math.random() - 0.5) * bodyRange;
    const close = parseFloat((open + move).toFixed(2));
    const high  = parseFloat((Math.max(open, close) + Math.random() * wickRange).toFixed(2));
    const low   = parseFloat((Math.min(open, close) - Math.random() * wickRange).toFixed(2));
    result.push({ timestamp: ts, open, high, low, close });
    price = close;
  }
  return result;
}

function generateInitialData() {
  candles.USDKRW = buildInitialCandles(state.USDKRW || 1451.0, 0.8,  0.25);
  candles.EURKRW = buildInitialCandles(state.EURKRW || 1715.0, 1.2,  0.40);
  candles.DXY    = buildInitialCandles(state.DXY    ||   97.0, 0.05, 0.02);
  // 오늘 일봉 추가
  if (state.USDKRW) updateTodayCandle('USDKRW', state.USDKRW);
  if (state.EURKRW) updateTodayCandle('EURKRW', state.EURKRW);
  if (state.DXY)    updateTodayCandle('DXY',    state.DXY);
  console.log('✅ 초기 캔들 24개 생성 + 일봉 씨드 로드');
}

async function crawlLoop() {
  console.log(`\n⏰ ${kstNow()}`);
  await crawlFx();
  await crawlDXY();
  if (state.USDKRW) storeCandle('USDKRW', state.USDKRW);
  if (state.EURKRW) storeCandle('EURKRW', state.EURKRW);
  if (state.DXY)    storeCandle('DXY',    state.DXY);
  // 일봉 오늘 캔들 갱신
  if (state.USDKRW) updateTodayCandle('USDKRW', state.USDKRW);
  if (state.EURKRW) updateTodayCandle('EURKRW', state.EURKRW);
  if (state.DXY)    updateTodayCandle('DXY',    state.DXY);
  state.spread10y = parseFloat((state.KR10Y - state.US10Y).toFixed(2));
  console.log('📊', JSON.stringify(state));
}

// ─── 서버 시작 ────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`🚀 환율 데이터 v8.0.0 - 포트 ${PORT} - BUILD_ID: ${BUILD_ID}`);
  await crawlFx();
  await crawlDXY();
  generateInitialData();
  setInterval(crawlLoop, 60000);
});

// ─── API ──────────────────────────────────────────────
app.get('/api/latest', (_, res) => res.json({
  version: '8.0.0', buildId: BUILD_ID, asofKST: kstNow(),
  USDKRW: state.USDKRW, EURKRW: state.EURKRW, DXY: state.DXY,
  KR10Y: state.KR10Y, US10Y: state.US10Y, spread10y: state.spread10y
}));

app.get('/api/candles', (req, res) => {
  const sym  = req.query.symbol || 'USDKRW';
  const data = (candles[sym] || []).map(c => ({
    time:  Math.floor(c.timestamp / 1000),
    open:  c.open, high: c.high, low: c.low, close: c.close
  }));
  res.json({ version: '8.0.0', symbol: sym, interval: '30m', count: data.length, data });
});

// ─── 일봉 API ─────────────────────────────────────────
app.get('/api/daily-candles', (req, res) => {
  const sym = req.query.symbol || 'USDKRW';
  const data = (dailyCandleSeeds[sym] || []);
  res.json({ version: '8.0.0', symbol: sym, interval: '1d', count: data.length, data });
});

app.get('/api/reserves', (_, res) => res.json({
  version: '8.0.0', asofKST: kstNow(),
  source: '한국은행', unit: 'USD bn', series: reservesData
}));

app.get('/api/market/today', async (_, res) => {
  try {
    const html = await fetchText('https://finance.naver.com/news/mainnews.naver', 'euc-kr');
    const $ = cheerio.load(html);
    const news = [];
    $('.newsList li').each((i, el) => {
      if (i >= 8) return false;
      const title = $(el).find('dd a').first().text().trim();
      const href  = $(el).find('dd a').first().attr('href');
      if (title && href)
        news.push({ title, url: href.startsWith('http') ? href : 'https://finance.naver.com' + href });
    });
    res.json({ version: '8.0.0', asofKST: kstNow(), news });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const aCache = new Map();

function calcTrend(series, valueKey = 'close') {
  const arr = Array.isArray(series) ? series.filter(Boolean) : [];
  if (arr.length < 2) return { first: null, last: null, pct: 0, dir: '횡보' };
  const first = Number(arr[0][valueKey]);
  const last = Number(arr[arr.length - 1][valueKey]);
  const pct = first ? ((last - first) / first) * 100 : 0;
  const dir = pct > 0.35 ? '상승' : pct < -0.35 ? '하락' : '횡보';
  return { first, last, pct, dir };
}

function getRecentDaily(sym, count = 5) {
  return (dailyCandleSeeds[sym] || []).slice(-count);
}

function getRecentIntraday(sym, count = 8) {
  return (candles[sym] || []).slice(-count);
}

async function callGeminiWithFallback(prompt, models = ['gemini-3.1-pro-preview', 'gemini-3-flash-preview']) {
  const KEY_GEM = process.env.GEMINI_API_KEY;
  if (!KEY_GEM) throw new Error('GEMINI_API_KEY 없음');

  let lastError = 'Gemini 응답 없음';
  for (const model of models) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY_GEM}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        }
      );

      if (!r.ok) {
        let detail = '';
        try { detail = await r.text(); } catch (_) {}
        const msg = `${model} HTTP ${r.status}${detail ? ' · ' + detail.slice(0, 160) : ''}`;
        if (r.status === 429 || r.status >= 500) {
          lastError = msg;
          continue;
        }
        throw new Error(msg);
      }

      const d = await r.json();
      const text = (d.candidates?.[0]?.content?.parts || [])
        .map(part => part?.text || '')
        .join('')
        .trim();

      if (text) return { text, model };
      lastError = `${model} 빈 응답`;
    } catch (err) {
      lastError = err.message || String(err);
    }
  }

  throw new Error(lastError);
}

function buildMarketFallback() {
  const usd = calcTrend(getRecentDaily('USDKRW'));
  const eur = calcTrend(getRecentDaily('EURKRW'));
  const dxy = calcTrend(getRecentDaily('DXY'));
  const spreadTone = state.spread10y <= -1 ? '미국 금리 우위가 이어져 원화에는 다소 부담입니다.' : '금리차 부담은 제한적입니다.';
  return `### 1. 시장 현황 진단
- USD/KRW는 ${state.USDKRW ?? '-'}원, EUR/KRW는 ${state.EURKRW ?? '-'}원, DXY는 ${state.DXY ?? '-'}로 집계됩니다.
- 최근 5거래일 기준 달러/원은 **${usd.dir}(${usd.pct.toFixed(2)}%)**, 유로/원은 **${eur.dir}(${eur.pct.toFixed(2)}%)**, DXY는 **${dxy.dir}(${dxy.pct.toFixed(2)}%)** 흐름입니다.

### 2. 주요 리스크 요인
- ${spreadTone}
- DXY가 ${dxy.dir} 국면이면 달러 강세/약세가 원화 환율에 바로 반영될 가능성이 큽니다.

### 3. 단기 전망
- 달러/원이 최근 고점권이면 단기 변동성 확대 가능성을, 눌림 구간이면 되돌림 가능성을 함께 봐야 합니다.
- 유로/원은 달러 흐름과 유로존 재료가 동시에 반영돼 달러/원보다 변동 해석이 복합적입니다.

### 4. 트레이딩 관점
- 환전은 한 번에 진입하기보다 **분할 매수**가 유효합니다.
- 현재 응답은 **Gemini 호출 한도 초과 시 제공되는 규칙 기반 백업 분석**입니다.`;
}

function buildBuyFallback(sym = 'USD') {
  const isEUR = String(sym).toUpperCase() === 'EUR';
  const mainSym = isEUR ? 'EURKRW' : 'USDKRW';
  const pairLabel = isEUR ? 'EUR/KRW' : 'USD/KRW';
  const pairUnit = isEUR ? '유로' : '달러';
  const price = isEUR ? Number(state.EURKRW || 0) : Number(state.USDKRW || 0);
  const daily = getRecentDaily(mainSym);
  const intraday = getRecentIntraday(mainSym);
  const dayTrend = calcTrend(daily);
  const intraTrend = calcTrend(intraday);
  const avg = daily.length ? daily.reduce((sum, c) => sum + Number(c.close || 0), 0) / daily.length : price || 0;
  let verdict = '🟡관망';
  if (price && avg) {
    if (price <= avg * 0.995) verdict = '🟢매입적기';
    else if (price >= avg * 1.005) verdict = '🔴매입보류';
  }
  return `### 1. ${pairLabel} 현재 수준 평가
- 현재 ${pairLabel}는 최근 5거래일 평균 ${avg ? avg.toFixed(1) : '-'}원 대비 ${price ? price.toFixed(2) : '-'}원입니다.
- **매입 판정: ${verdict}**

### 2. 단기 방향성 (1~5일)
- 최근 일봉은 **${dayTrend.dir}(${dayTrend.pct.toFixed(2)}%)**, 30분봉은 **${intraTrend.dir}(${intraTrend.pct.toFixed(2)}%)** 흐름입니다.
- 단기 급등 직후라면 추격 매수보다 분할 접근이 유리합니다.

### 3. 국제 정세 반영
- ${isEUR ? '유로존 경기·ECB·에너지 가격 변수' : 'DXY·연준·미국 정책 변수'}를 함께 체크해야 합니다.

### 4. 매입 전략 제안
- 한 번에 전량 매수보다 2~3회 **분할 매입**이 적절합니다.
- 직전 종가 평균 부근으로 눌릴 때 1차 접근을 고려하세요.

### 5. 다음 주 ${pairLabel} 전망
- 방향성은 **${dayTrend.dir} 우위**로 보되, 변동성은 계속 높을 수 있습니다.
- 현재 응답은 **Gemini 한도 초과 시 제공되는 백업 분석**입니다.`;
}

function buildWeeklyFallback() {
  const usd = calcTrend(getRecentDaily('USDKRW'));
  const eur = calcTrend(getRecentDaily('EURKRW'));
  const dxy = calcTrend(getRecentDaily('DXY'));
  return `### 1. 주간 환율 동향 요약
- 최근 구간에서 USD/KRW는 **${usd.dir}(${usd.pct.toFixed(2)}%)**, EUR/KRW는 **${eur.dir}(${eur.pct.toFixed(2)}%)** 흐름을 보였습니다.

### 2. 달러 강약세 분석
- DXY는 최근 **${dxy.dir}(${dxy.pct.toFixed(2)}%)** 흐름으로, 달러/원 방향성에 직접적인 영향을 줍니다.

### 3. 원화 환율 주요 변동 포인트
- 한미 금리차 ${state.spread10y}pp와 글로벌 위험선호 변화가 핵심 변수입니다.

### 4. 다음 주 전망 및 체크포인트
- 달러 강세가 이어지면 원화 약세 압력이 남고, 되돌림이 나오면 단기 환율 안정도 가능합니다.

### 5. 리스크 요인
- 현재 응답은 **Gemini 한도 초과 시 제공되는 규칙 기반 주간 요약**입니다.`;
}

// ─── 일반 AI 분석 ─────────────────────────────────────
app.get('/api/analysis', async (_, res) => {
  const KEY = 'fx_analysis';
  const hit = aCache.get(KEY);
  if (hit && Date.now() - hit.ts < 30 * 60000)
    return res.json({ analysis: hit.analysis, cached: true, model: hit.model || 'cache' });

  try {
    const prompt = `금융 시장 전문 애널리스트로서 현재 외환 시장을 심층 분석해주세요.

데이터: USD/KRW ${state.USDKRW}, EUR/KRW ${state.EURKRW}, DXY ${state.DXY}, KR10Y ${state.KR10Y}%, US10Y ${state.US10Y}%, 금리차 ${state.spread10y}pp

1. 시장 현황 진단
2. 주요 리스크 요인
3. 단기 전망
4. 트레이딩 관점

(한국어, Markdown, 500~800자)`;
    const result = await callGeminiWithFallback(prompt);
    const analysis = result.text;
    aCache.set(KEY, { analysis, ts: Date.now(), model: result.model });
    res.json({ version: '8.0.0', analysis, cached: false, model: result.model });
  } catch (e) {
    if (hit?.analysis) {
      return res.json({ version: '8.0.0', analysis: hit.analysis, cached: true, stale: true, warning: 'Gemini 호출 한도 초과로 최근 캐시를 반환했습니다.' });
    }
    const analysis = buildMarketFallback();
    res.json({ version: '8.0.0', analysis, cached: false, fallback: true, warning: 'Gemini 호출 한도 초과로 규칙 기반 분석을 반환했습니다.' });
  }
});

// ─── 주간 보고서 AI 분석 ──────────────────────────────
// ─── /api/buy-analysis : AI 매입 타이밍 (USD·EUR 공용) ────────
app.get('/api/buy-analysis', async (req2, res) => {
  const sym = (req2.query.symbol || 'USD').toUpperCase(); // USD | EUR
  try {
    const isEUR = sym === 'EUR';

    // 30분봉 최근 10개
    const mainSym   = isEUR ? 'EURKRW' : 'USDKRW';
    const mainRecent = (candles[mainSym] || []).slice(-10).map(c =>
      `${new Date(c.timestamp).toISOString().slice(11,16)} O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}`
    ).join('\\n') || '데이터 없음';
    const dxyRecent  = (candles.DXY || []).slice(-10).map(c =>
      `${new Date(c.timestamp).toISOString().slice(11,16)} C:${c.close.toFixed(2)}`
    ).join('\\n') || '데이터 없음';

    // 일봉 최근 5일
    const dailyRecent = (dailyCandleSeeds[mainSym] || []).slice(-5).map(c =>
      `${new Date(c.time*1000).toISOString().slice(0,10)}: C${c.close.toFixed(1)}`
    ).join(', ') || '데이터 없음';

    const pairLabel  = isEUR ? 'EUR/KRW' : 'USD/KRW';
    const pairPrice  = isEUR ? state.EURKRW : state.USDKRW;
    const pairUnit   = isEUR ? '유로' : '달러';

    const prompt = `당신은 외환 시장 전문 트레이딩 어드바이저입니다.
아래 실시간 데이터를 바탕으로 **${pairLabel} 매입 타이밍**을 정밀 판단해주세요.

## 현재 시장 데이터
- ${pairLabel}: ${pairPrice} 원
- USD/KRW: ${state.USDKRW} 원
- EUR/KRW: ${state.EURKRW} 원
- DXY 달러인덱스: ${state.DXY}
- 한국 10년물 금리: ${state.KR10Y}%
- 미국 10년물 금리: ${state.US10Y}%
- 한미 금리차: ${state.spread10y}pp

## ${pairLabel} 30분봉 (최근 10개)
${mainRecent}

## DXY 30분봉
${dxyRecent}

## ${pairLabel} 일봉 (최근 5일)
${dailyRecent}

## 분석 항목 (한국어, Markdown)

### 1. ${pairLabel} 현재 수준 평가
- 현재 ${pairLabel} 수준 (고평가/적정/저평가)
- **매입 판정: 🟢매입적기 / 🟡관망 / 🔴매입보류**

### 2. 단기 방향성 (1~5일)
- ${pairUnit} 강세/약세 전망 근거${isEUR ? '\\n- 유로존 경기·ECB 정책 영향' : '\\n- DXY 기반 달러 방향성'}
- 주요 지지·저항 레벨

### 3. 국제 정세 반영
- ${isEUR ? '유로존 리스크(ECB 정책, 유럽 지정학, 에너지 가격 등)' : '글로벌 리스크(미 무역정책, 연준 금리, 지정학 등)'}가 환율에 미치는 영향
- 주목해야 할 매크로 이벤트

### 4. 매입 전략 제안
- 추천 매입 시점 및 환율 레벨
- 분할 매입 전략
- 목표 환율 및 손절 기준

### 5. 다음 주 ${pairLabel} 전망
- 예상 레인지 (최저~최고)
- 핵심 변수 3가지

(500~700자, 명확한 결론 포함)`;

    const result = await callGeminiWithFallback(prompt);
    res.json({ analysis: result.text, symbol: sym, model: result.model });
  } catch(e) {
    res.json({ analysis: buildBuyFallback(sym), symbol: sym, fallback: true, warning: 'Gemini 호출 한도 초과로 규칙 기반 분석을 반환했습니다.' });
  }
});

app.get('/api/weekly-analysis', async (_, res) => {
  const KEY = 'weekly_analysis';
  const hit = aCache.get(KEY);
  if (hit && Date.now() - hit.ts < 30 * 60000)
    return res.json({ analysis: hit.analysis, cached: true, model: hit.model || 'cache' });

  try {
    const usdData = (dailyCandleSeeds.USDKRW || []).map(c =>
      `${new Date(c.time*1000).toISOString().slice(0,10)}: O${c.open} H${c.high} L${c.low} C${c.close}`
    ).join(', ');
    const eurData = (dailyCandleSeeds.EURKRW || []).map(c =>
      `${new Date(c.time*1000).toISOString().slice(0,10)}: O${c.open} H${c.high} L${c.low} C${c.close}`
    ).join(', ');
    const dxyData = (dailyCandleSeeds.DXY || []).map(c =>
      `${new Date(c.time*1000).toISOString().slice(0,10)}: O${c.open} H${c.high} L${c.low} C${c.close}`
    ).join(', ');

    const prompt = `금융 시장 전문 애널리스트로서 이번 주 환율 데이터를 분석하여 주간 보고서를 작성해주세요.

[USD/KRW 일봉]
${usdData}

[EUR/KRW 일봉]
${eurData}

[DXY 달러인덱스 일봉]
${dxyData}

[현재 시장]
USD/KRW: ${state.USDKRW}, EUR/KRW: ${state.EURKRW}, DXY: ${state.DXY}
KR10Y: ${state.KR10Y}%, US10Y: ${state.US10Y}%, 금리차: ${state.spread10y}pp

## 주간 보고서 작성 항목
1. 주간 환율 동향 요약
2. 달러 강약세 분석 (DXY 기반)
3. 원화 환율 주요 변동 포인트
4. 다음 주 전망 및 주요 체크포인트
5. 리스크 요인

(한국어, Markdown 형식, 700~1000자)`;

    const result = await callGeminiWithFallback(prompt);
    const analysis = result.text;
    aCache.set(KEY, { analysis, ts: Date.now(), model: result.model });
    res.json({ version: '8.0.0', analysis, cached: false, model: result.model });
  } catch (e) {
    if (hit?.analysis) {
      return res.json({ version: '8.0.0', analysis: hit.analysis, cached: true, stale: true, warning: 'Gemini 호출 한도 초과로 최근 캐시를 반환했습니다.' });
    }
    const analysis = buildWeeklyFallback();
    res.json({ version: '8.0.0', analysis, cached: false, fallback: true, warning: 'Gemini 호출 한도 초과로 규칙 기반 분석을 반환했습니다.' });
  }
});
