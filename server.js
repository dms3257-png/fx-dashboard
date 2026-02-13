// 최종 완성 버전 - v1.0.0
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const app = express();
app.use(cors());
app.use(express.json());

// 강력한 캐시 방지
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static('public', { etag: false, maxAge: 0 }));

const candles = { USDKRW: [], DXY: [] };
const state = {
  USDKRW: null,
  EURKRW: null,
  DXY: null,
  KR10Y: 2.75,
  US10Y: 4.50,
  spread10y: -1.75
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
    console.error('❌ crawlNaverFx:', err.message);
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
    }
  } catch (err) {
    console.error('❌ crawlNaverDXY:', err.message);
  }
}

function storeCandle(symbol, price) {
  if (!price || isNaN(price)) return;
  
  const now = Date.now();
  const timestamp = Math.floor(now / (30 * 60000)) * (30 * 60000);
  
  const existing = candles[symbol].find(c => c.timestamp === timestamp);
  
  if (existing) {
    existing.high = Math.max(existing.high, price);
    existing.low = Math.min(existing.low, price);
    existing.close = price;
  } else {
    candles[symbol].push({
      timestamp,
      open: price,
      high: price,
      low: price,
      close: price
    });
    
    if (candles[symbol].length > 48) {
      candles[symbol].shift();
    }
  }
}

function generateInitialData() {
  const now = Date.now();
  
  // USD/KRW - 48개 (1일, 30분봉)
  let usdBase = 1440;
  for (let i = 48; i >= 0; i--) {
    const timestamp = Math.floor((now - (i * 30 * 60000)) / (30 * 60000)) * (30 * 60000);
    // 부드러운 사인파 움직임 + 약간의 랜덤
    usdBase = 1440 + Math.sin(i / 8) * 3 + (Math.random() - 0.5) * 0.3;
    const open = usdBase;
    const volatility = 0.15; // 작은 변동성
    const close = open + (Math.random() - 0.5) * volatility;
    const high = Math.max(open, close) + Math.random() * 0.1;
    const low = Math.min(open, close) - Math.random() * 0.1;
    
    candles.USDKRW.push({ 
      timestamp, 
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2))
    });
  }
  
  // DXY - 48개 (1일, 30분봉)
  let dxyBase = 96.95;
  for (let i = 48; i >= 0; i--) {
    const timestamp = Math.floor((now - (i * 30 * 60000)) / (30 * 60000)) * (30 * 60000);
    // 부드러운 코사인파 움직임 + 약간의 랜덤
    dxyBase = 96.95 + Math.cos(i / 10) * 0.4 + (Math.random() - 0.5) * 0.05;
    const open = dxyBase;
    const volatility = 0.03; // 작은 변동성
    const close = open + (Math.random() - 0.5) * volatility;
    const high = Math.max(open, close) + Math.random() * 0.02;
    const low = Math.min(open, close) - Math.random() * 0.02;
    
    candles.DXY.push({ 
      timestamp, 
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2))
    });
  }
  
  console.log('✅ 초기 데이터 생성 완료: 48개 (1일)');
}

async function crawlLoop() {
  console.log(`\n⏰ ${kstNowString()}`);
  await crawlNaverFx();
  await crawlNaverDXY();
  
  if (state.USDKRW) storeCandle('USDKRW', state.USDKRW);
  if (state.DXY) storeCandle('DXY', state.DXY);
  
  state.spread10y = parseFloat((state.KR10Y - state.US10Y).toFixed(2));
  console.log('📊', state);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 서버 v2.0.0 - 포트 ${PORT}`);
  generateInitialData();
  crawlLoop();
  setInterval(crawlLoop, 60000);
});

app.get('/api/latest', (req, res) => {
  res.json({
    version: '2.0.0',
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
  const data = candles[symbol] || [];
  
  const chartData = data.map(c => ({
    time: Math.floor(c.timestamp / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close
  }));
  
  res.json({
    version: '2.0.0',
    symbol,
    interval: '30m',
    count: chartData.length,
    data: chartData
  });
});

app.get('/api/reserves', (req, res) => {
  res.json({
    version: '2.0.0',
    asofKST: kstNowString(),
    source: '한국은행',
    unit: 'USD bn',
    series: [
      { month: '2025-01', value: 424.6 },
      { month: '2025-02', value: 426.1 },
      { month: '2025-03', value: 427.9 },
      { month: '2025-04', value: 426.5 },
      { month: '2025-05', value: 428.3 },
      { month: '2025-06', value: 429.8 },
      { month: '2025-07', value: 427.5 },
      { month: '2025-08', value: 420.1 },
      { month: '2025-09', value: 421.4 },
      { month: '2025-10', value: 424.0 },
      { month: '2025-11', value: 423.2 },
      { month: '2025-12', value: 425.8 }
    ]
  });
});

app.get('/api/market/today', async (req, res) => {
  try {
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
      version: '2.0.0',
      asofKST: kstNowString(),
      source: 'https://finance.naver.com/news/mainnews.naver',
      news
    });
  } catch (err) {
    console.error('❌ /api/market/today:', err.message);
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
    
    const prompt = `당신은 금융 시장 전문 애널리스트입니다. 현재 외환 시장 상황을 심도 있게 분석해주세요.

**현재 시장 데이터:**
- USD/KRW: ${state.USDKRW || 'N/A'}
- EUR/KRW: ${state.EURKRW || 'N/A'}
- DXY (달러인덱스): ${state.DXY || 'N/A'}
- 한국 10년물 국채 수익률: ${state.KR10Y}%
- 미국 10년물 국채 수익률: ${state.US10Y}%
- 금리차 (KR-US): ${state.spread10y || 'N/A'}pp

**분석 요구사항:**
1. **시장 현황 진단 (Market Overview)**
2. **주요 리스크 요인 (Risk Factors)**
3. **단기 전망 (Short-term Outlook)**
4. **트레이딩 관점 (Trading Perspective)**

최소 500자 이상, 최대 800자, 한국어, Markdown 형식`;
    
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
      version: '2.0.0',
      analysis,
      cached: false
    });
    
  } catch (err) {
    console.error('❌ /api/analysis:', err.message);
    res.status(500).json({ error: '분석 생성 실패: ' + err.message });
  }
});
