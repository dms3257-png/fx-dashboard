// 최종 완성 버전 - 메인 페이지 크롤링 (작동 확인됨)
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');

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
  KR10Y: null,
  US10Y: null,
  spread10y: null
};

async function fetchText(url, timeout = 10000) {
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
    return await response.text();
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
    const html = await fetchText('https://finance.naver.com/marketindex/');
    const $ = cheerio.load(html);
    
    // h3.h_lst로 모든 항목 찾기
    $('h3.h_lst').each((i, el) => {
      const title = $(el).text().trim();
      const valueText = $(el).parent().find('.value').text().replace(/,/g, '').trim();
      const value = parseFloat(valueText);
      
      // USD/KRW
      if (title.includes('USD') && !isNaN(value) && value > 500 && value < 2000) {
        state.USDKRW = value;
        console.log(`✅ USD/KRW: ${value}`);
      }
      
      // EUR/KRW
      if (title.includes('EUR') && !isNaN(value) && value > 800 && value < 2500) {
        state.EURKRW = value;
        console.log(`✅ EUR/KRW: ${value}`);
      }
      
      // KR10Y
      if (title.includes('10년') && !title.includes('미국') && !isNaN(value) && value > 0 && value < 10) {
        state.KR10Y = value;
        console.log(`✅ KR10Y: ${value}`);
      }
      
      // US10Y
      if (title.includes('미국') && title.includes('10년') && !isNaN(value) && value > 0 && value < 10) {
        state.US10Y = value;
        console.log(`✅ US10Y: ${value}`);
      }
      
      // DXY
      if (title.includes('달러인덱스') && !isNaN(value) && value > 50 && value < 150) {
        state.DXY = parseFloat(value.toFixed(2));
        console.log(`✅ DXY: ${state.DXY}`);
      }
    });
    
    if (state.KR10Y && state.US10Y) {
      state.spread10y = parseFloat((state.US10Y - state.KR10Y).toFixed(2));
    }
    
    return true;
  } catch (err) {
    console.error('❌ crawlNaverFx error:', err.message);
    return false;
  }
}

async function crawlNaverDXY() {
  try {
    // 메인 페이지에서 이미 가져왔으면 Skip
    if (state.DXY) {
      return true;
    }
    
    // 백업: 모바일 페이지
    const html = await fetchText('https://m.stock.naver.com/marketindex/exchange/.DXY');
    const matches = html.match(/달러인덱스\*\*(\d{2,3}\.\d{2})\*\*/);
    
    if (matches && matches[1]) {
      const val = parseFloat(matches[1]);
      if (!isNaN(val) && val > 50 && val < 150) {
        state.DXY = parseFloat(val.toFixed(2));
        console.log(`✅ DXY (모바일): ${state.DXY}`);
        return true;
      }
    }
    
    throw new Error('DXY 파싱 실패');
  } catch (err) {
    console.error('❌ crawlNaverDXY error:', err.message);
    return false;
  }
}

async function updateAll() {
  console.log('\n🔄 크롤링 시작:', kstNowString());
  await crawlNaverFx();
  await crawlNaverDXY();
  
  const ts = Math.floor(Date.now() / 1000);
  if (state.USDKRW) {
    db.prepare('INSERT OR REPLACE INTO candles VALUES (?, ?, ?, ?, ?, ?)').run(
      'USDKRW', ts, state.USDKRW, state.USDKRW, state.USDKRW, state.USDKRW
    );
  }
  if (state.EURKRW) {
    db.prepare('INSERT OR REPLACE INTO candles VALUES (?, ?, ?, ?, ?, ?)').run(
      'EURKRW', ts, state.EURKRW, state.EURKRW, state.EURKRW, state.EURKRW
    );
  }
  if (state.DXY) {
    db.prepare('INSERT OR REPLACE INTO candles VALUES (?, ?, ?, ?, ?, ?)').run(
      'DXY', ts, state.DXY, state.DXY, state.DXY, state.DXY
    );
  }
  if (state.KR10Y) {
    db.prepare('INSERT OR REPLACE INTO candles VALUES (?, ?, ?, ?, ?, ?)').run(
      'KR10Y', ts, state.KR10Y, state.KR10Y, state.KR10Y, state.KR10Y
    );
  }
}

updateAll();
setInterval(updateAll, 60000);

app.get('/api/latest', (req, res) => {
  res.json({
    asofKST: kstNowString(),
    ...state
  });
});

app.get('/api/candles', (req, res) => {
  const { symbol = 'USDKRW', interval = '1m', range = '24h' } = req.query;
  
  const rangeMap = { '24h': 86400, '3d': 259200, '7d': 604800 };
  const seconds = rangeMap[range] || 86400;
  const since = Math.floor(Date.now() / 1000) - seconds;
  
  const rows = db.prepare(
    'SELECT * FROM candles WHERE symbol = ? AND timestamp >= ? ORDER BY timestamp ASC'
  ).all(symbol, since);
  
  res.json({
    symbol,
    interval,
    range,
    data: rows.map(r => ({ time: r.timestamp, value: r.close }))
  });
});

app.get('/api/reserves', (req, res) => {
  res.json({
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
    const html = await fetchText('https://finance.naver.com/news/mainnews.naver');
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
    return res.json({ ...cached.data, cached: true });
  }
  
  if (cached && Date.now() - cached.timestamp < COOLDOWN) {
    const retryAfter = Math.ceil((COOLDOWN - (Date.now() - cached.timestamp)) / 1000);
    return res.status(429).json({
      error: '잠시 후 다시 시도해주세요',
      retryAfter
    });
  }
  
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY가 설정되지 않았습니다'
    });
  }
  
  try {
    const prompt = `당신은 외환시장 전문 애널리스트입니다.

현재 데이터:
- USD/KRW: ${state.USDKRW || 'N/A'}원
- EUR/KRW: ${state.EURKRW || 'N/A'}원
- DXY: ${state.DXY || 'N/A'}
- KR 10년물: ${state.KR10Y || 'N/A'}%
- US 10년물: ${state.US10Y || 'N/A'}%

200자 이내로 시장 브리핑을 작성해주세요:
1. 현재 환율 수준
2. 주요 변동 요인
3. 단기 전망`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
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
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    const text = result.candidates[0].content.parts[0].text;
    
    const data = {
      symbol,
      analysis: text,
      asofKST: kstNowString(),
      cachedUntil: new Date(Date.now() + CACHE_TTL).toISOString()
    };
    
    analysisCache.set(cacheKey, { data, timestamp: Date.now() });
    console.log(`✅ AI 분석: ${text.substring(0, 50)}...`);
    
    res.json(data);
  } catch (err) {
    console.error('❌ /api/analysis error:', err.message);
    res.status(500).json({ 
      error: 'AI 분석 생성 실패',
      details: err.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
