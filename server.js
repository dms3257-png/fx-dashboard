// 최종 완성 - 외화보유액 수정 + 완벽한 캐시 제거
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const app = express();
app.use(cors());
app.use(express.json());

// 최강 캐시 방지
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Vary', '*');
  next();
});

app.use(express.static('public', {
  etag: false,
  lastModified: false,
  maxAge: 0,
  immutable: false
}));

const candles = {
  USDKRW: [],
  EURKRW: [],
  DXY: []
};

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
    
    if (candles[symbol].length > 672) {
      candles[symbol].shift();
    }
  }
}

function generateInitialData() {
  const now = Date.now();
  
  // USD/KRW - 30분봉 336개
  let usdBase = 1440;
  for (let i = 336; i >= 0; i--) {
    const timestamp = Math.floor((now - (i * 30 * 60000)) / (30 * 60000)) * (30 * 60000);
    
    usdBase += (Math.random() - 0.5) * 1.5;
    
    const open = usdBase;
    const volatility = Math.random() * 2;
    const close = open + (Math.random() - 0.5) * volatility;
    const high = Math.max(open, close) + Math.random() * 0.5;
    const low = Math.min(open, close) - Math.random() * 0.5;
    
    candles.USDKRW.push({ 
      timestamp, 
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2))
    });
  }
  
  // DXY - 30분봉 336개
  let dxyBase = 96.95;
  for (let i = 336; i >= 0; i--) {
    const timestamp = Math.floor((now - (i * 30 * 60000)) / (30 * 60000)) * (30 * 60000);
    
    dxyBase += (Math.random() - 0.5) * 0.15;
    
    const open = dxyBase;
    const volatility = Math.random() * 0.2;
    const close = open + (Math.random() - 0.5) * volatility;
    const high = Math.max(open, close) + Math.random() * 0.05;
    const low = Math.min(open, close) - Math.random() * 0.05;
    
    candles.DXY.push({ 
      timestamp, 
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2))
    });
  }
  
  console.log('✅ 초기 데이터: USD/KRW 336개, DXY 336개');
}

async function crawlLoop() {
  console.log(`\n⏰ ${kstNowString()}`);
  
  await crawlNaverFx();
  await crawlNaverDXY();
  
  if (state.USDKRW) storeCandle('USDKRW', state.USDKRW);
  if (state.EURKRW) storeCandle('EURKRW', state.EURKRW);
  if (state.DXY) storeCandle('DXY', state.DXY);
  
  if (state.KR10Y && state.US10Y) {
    state.spread10y = parseFloat((state.KR10Y - state.US10Y).toFixed(2));
  }
  
  console.log('📊', state);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 서버 포트 ${PORT}`);
  
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
  const data = candles[symbol] || [];
  
  const chartData = data.map(c => ({
    time: Math.floor(c.timestamp / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close
  }));
  
  res.json({
    symbol,
    interval: '30m',
    count: chartData.length,
    data: chartData
  });
});

// 외화보유액 - 2025년 12개월 (깔끔)
app.get('/api/reserves', (req, res) => {
  res.json({
    asofKST: kstNowString(),
    source: '한국은행',
    unit: 'USD bn',
    year: 2025,
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
   - 원/달러 환율의 현재 위치와 트렌드
   - DXY의 움직임과 글로벌 달러 수요 해석
   - 채권 금리차가 환율에 미치는 영향

2. **주요 리스크 요인 (Risk Factors)**
   - 환율 변동성을 높일 수 있는 국내외 요인
   - 금리차 확대/축소에 따른 자본유출입 리스크
   - 지정학적/경제적 불확실성

3. **단기 전망 (Short-term Outlook)**
   - 향후 1주일 내 예상 환율 범위와 근거
   - 주요 모니터링 지표 (Fed 발언, 무역수지 등)

4. **트레이딩 관점 (Trading Perspective)**
   - 현재 환율 수준에서의 포지셔닝 제안
   - 주요 기술적/심리적 지지/저항선

**형식:** 
- 각 섹션을 명확히 구분하여 작성
- 구체적인 수치와 논리적 근거 제시
- 최소 500자 이상, 최대 800자
- 한국어로 작성
- Markdown 형식 사용`;
    
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
