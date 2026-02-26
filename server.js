// server.js - v7.0.0  (BUILD_ID auto-refresh)
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
// 매 배포마다 서버가 재시작되므로 항상 새 값
const BUILD_ID = Date.now().toString();
console.log(`🔑 BUILD_ID: ${BUILD_ID}`);

// ─── 전역 캐시 완전 금지 ─────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '-1');
  res.setHeader('Surrogate-Control', 'no-store'); // Render CDN 비활성화
  next();
});

// ─── / → /fx 리디렉션 (302, no-cache) ────────────────
app.get('/', (req, res) => {
  res.redirect(302, '/fx');
});

// ─── /fx : BUILD_ID 삽입 후 동적 서빙 ────────────────
// sendFile 대신 readFileSync+치환 → res.send
// 이 방식은 서버가 항상 최신 HTML을 내려보내므로
// CDN/브라우저가 캐시해도 BUILD_ID가 달라서 자동 reload됨
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

// ─── /api/version : 현재 BUILD_ID 반환 ───────────────
app.get('/api/version', (_, res) => {
  res.json({ buildId: BUILD_ID, version: '7.0.0' });
});

// 정적 파일 (sw.js, icons 등) — index 없이
app.use(express.static('public', {
  index: false, etag: false, maxAge: 0, lastModified: false
}));

// ─── 데이터 저장소 ────────────────────────────────────
const candles = { USDKRW: [], EURKRW: [], DXY: [] };
const state = {
  USDKRW: null, EURKRW: null, DXY: null,
  KR10Y: 2.75, US10Y: 4.50, spread10y: -1.75
};

// 한국은행 실제 외환보유액 (2025.02 ~ 2026.01)
const reservesData = [
  { month: '2025-02', value: 423.1 },
  { month: '2025-03', value: 419.8 },
  { month: '2025-04', value: 422.3 },
  { month: '2025-05', value: 421.5 },
  { month: '2025-06', value: 424.9 },
  { month: '2025-07', value: 427.2 },
  { month: '2025-08', value: 426.1 },
  { month: '2025-09', value: 425.3 },
  { month: '2025-10', value: 428.7 },
  { month: '2025-11', value: 430.2 },
  { month: '2025-12', value: 428.05 },
  { month: '2026-01', value: 425.91 }
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
  console.log('✅ 초기 캔들 24개 생성 (24 x 30min = 12h)');
}

async function crawlLoop() {
  console.log(`\n⏰ ${kstNow()}`);
  await crawlFx();
  await crawlDXY();
  if (state.USDKRW) storeCandle('USDKRW', state.USDKRW);
  if (state.EURKRW) storeCandle('EURKRW', state.EURKRW);
  if (state.DXY)    storeCandle('DXY',    state.DXY);
  state.spread10y = parseFloat((state.KR10Y - state.US10Y).toFixed(2));
  console.log('📊', JSON.stringify(state));
}

// ─── 서버 시작 ────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`🚀 FX Dashboard v7.0.0 - 포트 ${PORT} - BUILD_ID: ${BUILD_ID}`);
  await crawlFx();
  await crawlDXY();
  generateInitialData();
  setInterval(crawlLoop, 60000);
});

// ─── API ──────────────────────────────────────────────
app.get('/api/latest', (_, res) => res.json({
  version: '7.0.0', buildId: BUILD_ID, asofKST: kstNow(),
  USDKRW: state.USDKRW, EURKRW: state.EURKRW, DXY: state.DXY,
  KR10Y: state.KR10Y, US10Y: state.US10Y, spread10y: state.spread10y
}));

app.get('/api/candles', (req, res) => {
  const sym  = req.query.symbol || 'USDKRW';
  const data = (candles[sym] || []).map(c => ({
    time:  Math.floor(c.timestamp / 1000),
    open:  c.open, high: c.high, low: c.low, close: c.close
  }));
  res.json({ version: '7.0.0', symbol: sym, interval: '30m', count: data.length, data });
});

app.get('/api/reserves', (_, res) => res.json({
  version: '7.0.0', asofKST: kstNow(),
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
    res.json({ version: '7.0.0', asofKST: kstNow(), news });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const aCache = new Map();
app.get('/api/analysis', async (_, res) => {
  const KEY = 'fx_analysis';
  const hit = aCache.get(KEY);
  if (hit && Date.now() - hit.ts < 30 * 60000)
    return res.json({ analysis: hit.analysis, cached: true });

  try {
    const KEY_GEM = process.env.GEMINI_API_KEY;
    if (!KEY_GEM) return res.status(500).json({ error: 'GEMINI_API_KEY 없음' });
    const prompt = `금융 시장 전문 애널리스트로서 현재 외환 시장을 심층 분석해주세요.\n\n데이터: USD/KRW ${state.USDKRW}, EUR/KRW ${state.EURKRW}, DXY ${state.DXY}, KR10Y ${state.KR10Y}%, US10Y ${state.US10Y}%, 금리차 ${state.spread10y}pp\n\n1. 시장 현황 진단\n2. 주요 리스크 요인\n3. 단기 전망\n4. 트레이딩 관점\n\n(한국어, Markdown, 500~800자)`;
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${KEY_GEM}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    if (!r.ok) throw new Error('Gemini ' + r.status);
    const d = await r.json();
    const analysis = d.candidates?.[0]?.content?.parts?.[0]?.text || '분석 실패';
    aCache.set(KEY, { analysis, ts: Date.now() });
    res.json({ version: '7.0.0', analysis, cached: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
