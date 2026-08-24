// โมเดลวิเคราะห์สัญญาณเทรด — ใช้ร่วมกันทั้งฝั่งเว็บ (src/app.js) และฝั่งเซิร์ฟเวอร์ (scripts/check-orders.mjs)
// เพื่อให้การตัดสินใจซื้อ/ขายอัตโนมัติตรงกับสิ่งที่คำนวณจริง ไม่เพี้ยนกันระหว่างสองฝั่ง
//
// รวม 5 เทคนิคที่ใช้กันแพร่หลายในการวิเคราะห์ทางเทคนิค (technical analysis "confluence") เข้าด้วยกัน:
//   1. Monte Carlo forecast จาก log-return ล่าสุด (ใช้เดิมอยู่แล้ว) — ความน่าจะเป็นที่ราคาจะขึ้น
//   2. RSI (Wilder's, 14 แท่ง) — โมเมนตัม บอกภาวะซื้อมากไป/ขายมากไป (overbought/oversold)
//   3. EMA 9 vs EMA 21 — แนวโน้มระยะสั้น (trend) ผ่านการตัดกันของเส้นค่าเฉลี่ยเคลื่อนที่แบบถ่วงน้ำหนัก
//   4. Bollinger Bands (20 แท่ง, 2 ส่วนเบี่ยงเบนมาตรฐาน) — ความผันผวน/แนวรับแนวต้านเชิงสถิติ
//   5. MACD (12/26/9) — โมเมนตัมเชิงแนวโน้ม บอกจังหวะตัดกันของเส้น MACD กับเส้น signal
// แล้วโหวตรวมกันแบบเสียงข้างมาก (confluence) แทนที่จะเชื่อสัญญาณเดียว ลดโอกาสสัญญาณหลอก

export function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1);
  return Math.sqrt(v);
}

export function computeReturns(candles) {
  const r = [];
  for (let i = 1; i < candles.length; i++) {
    const prevC = candles[i - 1].c, curC = candles[i].c;
    if (prevC > 0 && curC > 0) r.push(Math.log(curC / prevC));
  }
  return r.length > 150 ? r.slice(-150) : r;
}

export function computeForecast(price, candles, returns) {
  if (!price || candles.length < 5) return null;
  const horizon = 20;
  const sigma = stdev(returns) || 0.001;
  const recent = returns.slice(-30);
  const drift = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const paths = 250;
  const finals = [];
  const seriesSum = new Array(horizon).fill(0);
  for (let p = 0; p < paths; p++) {
    let pr = price;
    for (let i = 0; i < horizon; i++) {
      const shock = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
      pr = pr * (1 + drift * 0.6 + shock * sigma);
      seriesSum[i] += pr;
    }
    finals.push(pr);
  }
  finals.sort((a, b) => a - b);
  const median = finals[Math.floor(paths / 2)];
  const p10 = finals[Math.floor(paths * 0.10)];
  const p90 = finals[Math.floor(paths * 0.90)];
  const upCount = finals.filter((f) => f > price).length;
  const probUp = upCount / paths;
  const medianSeries = seriesSum.map((s) => s / paths);
  return { horizon, median, p10, p90, probUp, medianSeries };
}

// RSI แบบ Wilder's smoothing มาตรฐาน (ไม่ใช่ค่าเฉลี่ยธรรมดา) — คำนวณจากราคาปิดทั้งช่วงที่มี
export function computeRSI(candles, period) {
  period = period || 14;
  if (candles.length < period + 1) return null;
  const gains = [], losses = [];
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].c - candles[i - 1].c;
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let j = period; j < gains.length; j++) {
    avgGain = (avgGain * (period - 1) + gains[j]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[j]) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function computeEMA(candles, period) {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((a, c) => a + c.c, 0) / period;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].c * k + ema * (1 - k);
  }
  return ema;
}

export function computeBollinger(candles, period, mult) {
  period = period || 20;
  mult = mult || 2;
  if (candles.length < period) return null;
  const slice = candles.slice(-period).map((c) => c.c);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mid) * (b - mid), 0) / period;
  const sd = Math.sqrt(variance);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

// คืนค่า EMA ทั้งช่วง (ไม่ใช่แค่ค่าล่าสุด) — ใช้สำหรับคำนวณ MACD ที่ต้องเอา EMA ของเส้น MACD อีกที
function computeEMASeries(candles, period) {
  if (candles.length < period) return [];
  const k = 2 / (period + 1);
  const series = [];
  let ema = candles.slice(0, period).reduce((a, c) => a + c.c, 0) / period;
  series.push(ema);
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].c * k + ema * (1 - k);
    series.push(ema);
  }
  return series;
}

// MACD (12/26/9) มาตรฐาน — เส้น MACD = EMA12 - EMA26, เส้น signal = EMA9 ของเส้น MACD, histogram = MACD - signal
export function computeMACD(candles, fast, slow, signalPeriod) {
  fast = fast || 12; slow = slow || 26; signalPeriod = signalPeriod || 9;
  if (candles.length < slow + signalPeriod) return null;
  const emaFastSeries = computeEMASeries(candles, fast);
  const emaSlowSeries = computeEMASeries(candles, slow);
  const offset = emaFastSeries.length - emaSlowSeries.length; // emaFastSeries เริ่มเร็วกว่าเสมอ (period น้อยกว่า)
  const macdSeries = emaSlowSeries.map((slowV, i) => emaFastSeries[i + offset] - slowV);
  if (macdSeries.length < signalPeriod) return null;

  const k = 2 / (signalPeriod + 1);
  let signalEma = macdSeries.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
  for (let i = signalPeriod; i < macdSeries.length; i++) {
    signalEma = macdSeries[i] * k + signalEma * (1 - k);
  }
  const macd = macdSeries[macdSeries.length - 1];
  return { macd, signal: signalEma, histogram: macd - signalEma };
}

// รวมสัญญาณทั้ง 5 แบบเป็นการโหวตเสียงข้างมาก (confluence) — bearish/bullish ต้องได้เสียงเกินครึ่งของสัญญาณที่มีข้อมูลจริง
export function computeSignal(price, candles, returns) {
  returns = returns || computeReturns(candles);
  const forecast = computeForecast(price, candles, returns);
  const rsi = computeRSI(candles, 14);
  const emaFast = computeEMA(candles, 9);
  const emaSlow = computeEMA(candles, 21);
  const bb = computeBollinger(candles, 20, 2);
  const macd = computeMACD(candles, 12, 26, 9);

  const trendUp = emaFast != null && emaSlow != null ? emaFast > emaSlow : null;
  const overbought = rsi != null && rsi > 70;
  const oversold = rsi != null && rsi < 30;
  const nearUpperBand = bb != null && price >= bb.upper;
  const nearLowerBand = bb != null && price <= bb.lower;
  const probDown = forecast ? forecast.probUp < 0.45 : null;
  const probUpSignal = forecast ? forecast.probUp >= 0.55 : null;
  const macdBearish = macd != null && macd.histogram < 0;
  const macdBullish = macd != null && macd.histogram > 0;

  let bearishVotes = 0, bullishVotes = 0, totalVotes = 0;
  if (trendUp != null) { totalVotes++; if (!trendUp) bearishVotes++; else bullishVotes++; }
  if (rsi != null) { totalVotes++; if (overbought) bearishVotes++; else if (oversold) bullishVotes++; }
  if (bb != null) { totalVotes++; if (nearUpperBand) bearishVotes++; else if (nearLowerBand) bullishVotes++; }
  if (forecast) { totalVotes++; if (probDown) bearishVotes++; else if (probUpSignal) bullishVotes++; }
  if (macd != null) { totalVotes++; if (macdBearish) bearishVotes++; else if (macdBullish) bullishVotes++; }

  return {
    forecast, rsi, emaFast, emaSlow, bb, macd,
    trendUp, overbought, oversold, nearUpperBand, nearLowerBand, macdBearish, macdBullish,
    bearishVotes, bullishVotes, totalVotes,
    bearish: totalVotes > 0 && bearishVotes >= Math.ceil(totalVotes / 2),
    bullish: totalVotes > 0 && bullishVotes >= Math.ceil(totalVotes / 2),
  };
}
