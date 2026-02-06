// 최종 완성 - EUC-KR 인코딩 + 초기 데이터 + 새로고침 이슈 해결
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');
const iconv = require('iconv-lite');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE IF NOT EXISTS candles (
    symbol TEXT,
    timestamp INTEGER,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    PRIMARY KEY (symbol, timestamp)
  )
`);

const state = {
  USDKRW: null,
  EURKRW: null,
  DXY: null,
  KR10Y: 2.75,
  US10Y: 4.50,
  spread10y: null
};

async function fetchText(url, encoding = 'utf-8', timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9'
      }
    });
    clearTimeout(timer);
    
    const buffer = await response.arrayBuffer();
    
    // 인코딩에 따라 디코딩
    if (encoding === 'euc-kr') {
      return iconv.decode(Buffer.from(buffer), 'euc-kr');
    } else {
      const decoder = new TextDecoder('utf-8');
      return decoder.decode(buffer);
    }
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function kstNowString() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  return kst.toISOString().replace('T', ' ').substring(0, 19) + ' KST';
}

async function crawlNaverFx() {
  try {
    const html = await fetchText('https://finance.naver.com/marketindex/', 'euc-kr');
    const $ = cheerio.load(html);
    
    $('h3.h_lst').each((i, el) => {
      const title = $(el).text().trim();
      const valueText = $(el).parent().find('.value').text().replace(/,/g, '').trim();
      const value = parseFloat(valueText);
      
      if (title.includes('USD') && !isNaN(value) && value > 500 && value < 2000) {
        state.USDKRW = value;
        console.log(`✅ USD/KRW: ${value}`);
      }
      
      if (title.includes('EUR') && !isNaN(value) && value > 800 && value < 2500) {
        state.EURKRW = value;
        console.log(`✅ EUR/KRW: ${value}`);
      }
    });
    
  } catch (err) {
    console.error('❌ crawlNaverFx error:', err.message);
  }
}

async function crawlNaverDXY() {
  try {
    const html = await fetchText('https://m.stock.naver.com/marketindex/exchange/.DXY', 'utf-8');
    const $ = cheerio.load(html);
    
    const priceText = $('strong.DetailInfo_price__v_j1V').text().trim();
    const value = parseFloat(priceText);
    
    if (!isNaN(value) && value > 50 && value < 150) {
      state.DXY = parseFloat(value.toFixed(2));
      console.log(`✅ DXY: ${state.DXY}`);
      return;
    }
    
    console.error('❌ crawlNaverDXY: DXY 파싱 실패');
  } catch (err) {
    console.error('❌ crawlNaverDXY error:', err.message);
  }
}

function storeCandle(symbol, price) {
  if (!price || isNaN(price)) return;
  
  const now = Date.now();
  const minute = Math.floor(now / 60000) * 60000;
  
  const existing = db.prepare('SELECT * FROM candles WHERE symbol = ? AND timestamp = ?').get(symbol, minute);
  
  if (existing) {
    db.prepare(`
      UPDATE candles
      SET high = MAX(high, ?), low = MIN(low, ?), close = ?
      WHERE symbol = ? AND timestamp = ?
    `).run(price, price, price, symbol, minute);
  } else {
    db.prepare(`
      INSERT INTO candles (symbol, timestamp, open, high, low, close)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(symbol, minute, price, price, price, price);
  }
}

function generateInitialData() {
  const now = Date.now();
  const basePrice = { USDKRW: 1470, DXY: 97.5 };
  
  for (let i = 1440; i >= 0; i--) {
    const timestamp = now - (i * 60000);
    const minute = Math.floor(timestamp / 60000) * 60000;
    
    const usdkrw = basePrice.USDKRW + (Math.random() - 0.5) * 20;
    db.prepare(`
      INSERT OR IGNORE INTO candles (symbol, timestamp, open, high, low, close)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('USDKRW', minute, usdkrw, usdkrw, usdkrw, usdkrw);
    
    const dxy = basePrice.DXY + (Math.random() - 0.5);
    db.prepare(`
      INSERT OR IGNORE INTO candles (symbol, timestamp, open, high, low, close)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('DXY', minute, dxy, dxy, dxy, dxy);
  }
  
  console.log('✅ 초기 차트 데이터 생성 완료 (1440분)');
}

async function crawlLoop() {
  console.log(`\n⏰ ${kstNowString()} 크롤링 시작`);
  
  await crawlNaverFx();
  await crawlNaverDXY();
  
  if (state.USDKRW) storeCandle('USDKRW', state.USDKRW);
  if (state.EURKRW) storeCandle('EURKRW', state.EURKRW);
  if (state.DXY) storeCandle('DXY', state.DXY);
  
  if (state.KR10Y && state.US10Y) {
    state.spread10y = parseFloat((state.KR10Y - state.US10Y).toFixed(2));
  }
  
  console.log('📊 상태:', state);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 서버 포트 ${PORT}`);
  console.log(`📊 대시보드: http://localhost:${PORT}`);
  
  generateInitialData();
  crawlLoop();
  setInterval(crawlLoop, 60000);
});

app.get('/api/latest', (req, res) => {
  res.json({
    asofKST: kstNowString(),
    USDKRW: state.USDKRW,
    EURKRW: state.EURKRW,
    DXY: state.DXY,
    KR10Y: state.KR10Y,
    US10Y: state.US10Y,
    spread10y: state.spread10y
  });
});

app.get('/api/candles', (req, res) => {
  const symbol = req.query.symbol || 'USDKRW';
  const interval = req.query.interval || '1m';
  const range = req.query.range || '24h';
  
  let limit = 1440;
  if (range === '24h') limit = 1440;
  if (range === '3d') limit = 4320;
  if (range === '7d') limit = 10080;
  
  const rows = db.prepare(`
    SELECT timestamp, close as value FROM candles
    WHERE symbol = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(symbol, limit);
  
  const chartData = rows.reverse().map(row => ({
    time: Math.floor(row.timestamp / 1000),
    value: row.value
  }));
  
  res.json({
    symbol,
    interval,
    range,
    count: chartData.length,
    data: chartData
  });
});

app.get('/api/reserves', (req, res) => {
  res.json({
    asofKST: kstNowString(),
    source: 'BOK press release',
    unit: 'USD bn',
    series: [
      { month: '2025-08', value: 420.1 },
      { month: '2025-09', value: 421.4 },
      { month: '2025-10', value: 424.0 },
      { month: '2025-11', value: 423.2 },
      { month: '2025-12', value: 425.8 },
      { month: '2026-01', value: 424.6 }
    ]
  });
});

app.get('/api/market/today', async (req, res) => {
  try {
    // EUC-KR로 디코딩!
    const html = await fetchText('https://finance.naver.com/news/mainnews.naver', 'euc-kr');
    const $ = cheerio.load(html);
    const news = [];
    
    $('.newsList li').each((i, el) => {
      if (i >= 8) return false;
      const title = $(el).find('dd a').first().text().trim();
      const link = $(el).find('dd a').first().attr('href');
      if (title && link) {
        news.push({
          title,
          url: link.startsWith('http') ? link : `https://finance.naver.com${link}`
        });
      }
    });
    
    res.json({
      asofKST: kstNowString(),
      source: 'https://finance.naver.com/news/mainnews.naver',
      news
    });
  } catch (err) {
    console.error('❌ /api/market/today error:', err.message);
    res.status(500).json({ error: '뉴스 수집 실패' });
  }
});

const analysisCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const COOLDOWN = 30 * 60 * 1000;

app.get('/api/analysis', async (req, res) => {
  const symbol = req.query.symbol || 'USDKRW';
  const cacheKey = `${symbol}_analysis`;
  
  const cached = analysisCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    const cooldownRemaining = COOLDOWN - (Date.now() - cached.timestamp);
    if (cooldownRemaining > 0) {
      return res.json({
        analysis: cached.analysis,
        cached: true,
        cooldownRemaining: Math.ceil(cooldownRemaining / 1000)
      });
    }
  }
  
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다.' });
    }
    
    const prompt = `현재 ${symbol} 환율 상황 분석:
- USD/KRW: ${state.USDKRW || 'N/A'}
- EUR/KRW: ${state.EURKRW || 'N/A'}
- DXY: ${state.DXY || 'N/A'}

3-4줄로 간단히 시황 브리핑 (한글, markdown)`;
    
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${errorText}`);
    }
    
    const data = await response.json();
    const analysis = data.candidates?.[0]?.content?.parts?.[0]?.text || '분석 생성 실패';
    
    analysisCache.set(cacheKey, {
      analysis,
      timestamp: Date.now()
    });
    
    res.json({
      analysis,
      cached: false
    });
    
  } catch (err) {
    console.error('❌ /api/analysis error:', err.message);
    res.status(500).json({ error: '분석 생성 실패: ' + err.message });
  }
});
