// รันโดย GitHub Actions ตามตารางเวลา (cron) — เช็คคำสั่งรอราคาของทุกผู้ใช้แล้วยิงคำสั่งซื้อ/ขายอัตโนมัติ
// ให้แม้ผู้ใช้จะไม่ได้เปิดหน้าเว็บค้างไว้ก็ตาม (ทำงานฝั่งเซิร์ฟเวอร์ผ่าน Firebase Admin SDK)
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { computeReturns, computeSignal } from "../shared/signals.mjs";
import { scoreMarket, describeScore, positionFraction, THRESHOLDS } from "../shared/strategy.mjs";
import { evaluateIndicators, describeLearning } from "../shared/backtest.mjs";

const FEE_RATES = { binance: 0.001, bitkub: 0.0025 };
const LEDGER_KEY = { binance: "usd", bitkub: "thb" };
const PROFIT_TARGET = 0.02; // เป้าหมายกำไรขั้นต่ำต่อรอบ 2% (ตรงกับฝั่งเว็บ)
const STOP_LOSS_PCT = 0.05; // ตัดขาดทุนเฉพาะตอน "จำเป็นจริงๆ" เท่านั้น — ขาดทุนหนักถึง 5% และสัญญาณรวมยืนยันเป็นขาลงชัดเจน (ไม่ใช่แค่ผันผวนระยะสั้น)
// เป้าหมายส่วนต่างเหรียญต่อรอบครบวง (ขาย -> ซื้อคืน)
// เดิมตั้งไว้ 1% ซึ่งบังคับให้ราคาต้องย่อลงมา ~1.2% ต่ำกว่าจุดที่ขาย กว่าจะซื้อคืนได้
// ทดสอบย้อนหลังจริงแล้วพบว่ารอบแทบไม่เคยปิดครบเลย (0-2 รอบใน 42 วัน) = กลไกสะสมเหรียญแทบไม่ทำงาน
// ลดเหลือ 0.25% เพื่อให้รอบปิดได้จริง กำไรต่อรอบน้อยลงแต่หมุนได้บ่อยขึ้น
const BTC_ACCUM_TARGET = 0.0025;

// ราคาซื้อคืนสูงสุดที่ยังทำให้ได้ "จำนวนเหรียญเพิ่มขึ้น" ตามเป้า หลังหักค่าธรรมเนียมทั้งขาขายและขาซื้อแล้ว
//   ขาย Q เหรียญที่ Ps -> ได้เงินสด Q*Ps*(1-f) -> ซื้อคืนที่ Pb ได้ Q' = Q*Ps*(1-f) / (Pb*(1+f))
//   ต้องการ Q'/Q >= 1+g  =>  Pb <= Ps*(1-f) / ((1+f)*(1+g))
// ถ้าซื้อคืนแพงกว่านี้ ต่อให้ "กำไรเป็นเงิน" ก็จะได้เหรียญ "น้อยลง" ซึ่งขัดกับเป้าหมายสะสม BTC
function btcAccumCeiling(sellPrice, feeRate, gain) {
  return (sellPrice * (1 - feeRate)) / ((1 + feeRate) * (1 + gain));
}
const KLINE_LIMIT = 300; // ดึงย้อนหลังเยอะขึ้นเพื่อให้มีข้อมูลพอสำหรับประเมินอินดิเคเตอร์ย้อนหลัง (backtest)
const MAX_OPEN_SWING = 8;            // เพดานไม้ swing ที่เปิดพร้อมกัน
const MIN_SWING_SEPARATION_PCT = 0.5; // ไม้ใหม่ต้องห่างจากไม้ที่ถืออยู่อย่างน้อยเท่านี้ (%)
const CORE_BUY_INTERVAL_MS = 12 * 60 * 60 * 1000; // ขาสะสมระยะยาว: ทยอยซื้อทุก 12 ชั่วโมง
const CORE_BUY_FRACTION = 0.10; // ใช้เงินสด 10% ต่อการสะสมระยะยาว 1 ครั้ง

function round2(n) { return Math.round(n * 100) / 100; }

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT env var");
  return JSON.parse(raw);
}

async function fetchBinancePrice() {
  // api.binance.com บล็อก IP ของ GitHub Actions runner (มักอยู่ในสหรัฐฯ) ด้วยเหตุผลกฎหมาย
  // ลอง Binance ก่อน แล้วสำรองด้วย CoinGecko ถ้าเรียกไม่ได้
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
    if (!res.ok) throw new Error("binance http " + res.status);
    const data = await res.json();
    const p = parseFloat(data.price);
    if (p > 0) return p;
    throw new Error("binance returned invalid price");
  } catch (err) {
    console.warn("binance fetch failed, falling back to CoinGecko:", err.message);
    const res2 = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
    const data2 = await res2.json();
    return data2.bitcoin ? data2.bitcoin.usd : null;
  }
}

async function fetchBitkubPrice() {
  // เซิร์ฟเวอร์เรียกตรงได้เลย ไม่ติด CORS เหมือนฝั่งเบราว์เซอร์
  const res = await fetch("https://api.bitkub.com/api/market/ticker");
  const data = await res.json();
  return data.THB_BTC ? data.THB_BTC.last : null;
}

async function fetchBinanceCandles() {
  // api.binance.com บล็อก IP ของ GitHub Actions runner (HTTP 451) เหมือนกับ endpoint ราคา
  // ลอง Binance ก่อน แล้วสำรองด้วยแท่งเทียน 1 นาทีจาก Coinbase Exchange (public, ไม่บล็อก, granularity ตรงกัน)
  try {
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=${KLINE_LIMIT}`);
    if (!res.ok) throw new Error("binance klines http " + res.status);
    const data = await res.json();
    return data.map((k) => ({ t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]) }));
  } catch (err) {
    console.warn("binance klines fetch failed, falling back to Coinbase:", err.message);
    try {
      const res2 = await fetch("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60");
      if (!res2.ok) throw new Error("coinbase candles http " + res2.status);
      const data2 = await res2.json(); // [ [time, low, high, open, close, volume], ... ] ใหม่สุดก่อน
      const candles = data2.map((k) => ({ t: k[0] * 1000, o: k[3], h: k[2], l: k[1], c: k[4] })).reverse();
      return candles.slice(-KLINE_LIMIT);
    } catch (err2) {
      console.error("coinbase candles fallback also failed, auto-trade signal unavailable this run:", err2.message);
      return null;
    }
  }
}

async function fetchBitkubCandles() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 60 * KLINE_LIMIT;
    const res = await fetch(`https://api.bitkub.com/tradingview/history?symbol=BTC_THB&resolution=1&from=${from}&to=${now}`);
    const data = await res.json();
    if (!data || !data.c || !data.t) return null;
    return data.t.map((t, i) => ({ t: t * 1000, o: data.o[i], h: data.h[i], l: data.l[i], c: data.c[i] }));
  } catch (err) {
    console.warn("bitkub klines fetch failed, auto-trade signal unavailable this run:", err.message);
    return null;
  }
}

// จำลองการเทรดแบบเดียวกับฝั่งเว็บ (src/app.js doTrade) — คืนค่า ledger ใหม่ + record การเทรด
function applyTrade(ledger, side, amountRaw, price, feeRate) {
  const acc = { cash: ledger.cash, btc: ledger.btc, avgEntry: ledger.avgEntry, lots: (ledger.lots || []).map((l) => ({ ...l })), orders: ledger.orders || [] };
  let amount = amountRaw;
  if (side === "buy" && amount * (1 + feeRate) > acc.cash) amount = acc.cash / (1 + feeRate);
  if (side === "sell") {
    const maxSellAmt = acc.btc * price;
    if (amount > maxSellAmt) amount = maxSellAmt;
  }
  if (amount <= 0.01) return null;

  const fee = amount * feeRate;
  const qty = amount / price;
  if (side === "buy") {
    acc.lots.push({ ts: Date.now(), qty, price });
    acc.btc += qty;
    acc.cash -= amount + fee;
  } else {
    let remaining = qty;
    const newLots = [];
    for (const lot of acc.lots) {
      if (remaining <= 1e-9) { newLots.push(lot); continue; }
      if (lot.qty <= remaining) { remaining -= lot.qty; }
      else { newLots.push({ ts: lot.ts, qty: lot.qty - remaining, price: lot.price }); remaining = 0; }
    }
    acc.lots = newLots;
    acc.btc -= qty;
    acc.cash += amount - fee;
    if (acc.btc < 1e-9) { acc.btc = 0; acc.lots = []; }
  }
  const lotsTotalCost = acc.lots.reduce((a, l) => a + l.qty * l.price, 0);
  acc.avgEntry = acc.btc > 0 ? lotsTotalCost / acc.btc : 0;

  return { ledger: acc, amount, fee, qty };
}

// ขาย "รอบที่ระบุ" เจาะจงตัวล็อตนั้นโดยตรง (ไม่ใช้ FIFO ทั่วไปแบบ applyTrade) — จำเป็นสำหรับออโต้เทรด
// เพราะรอบที่เข้าเงื่อนไข (กำไรถึงเป้า/ขาดทุนเกิน) อาจไม่ใช่ล็อตที่เก่าที่สุด การใช้ applyTrade ทั่วไป
// จะไปกินโควตาจากล็อตหน้าสุดผิดตัว ทำให้ล็อตที่เข้าเงื่อนไขจริงไม่เคยถูกขายออกและวนซ้ำไม่รู้จบ
function sellSpecificLot(ledger, matchLot, price, feeRate) {
  const lots = (ledger.lots || []).map((l) => ({ ...l }));
  const idx = lots.findIndex((l) => l.ts === matchLot.ts && Math.abs(l.price - matchLot.price) < 1e-9);
  if (idx === -1) return null; // ล็อตนี้ถูกจัดการไปแล้ว (เช่น รันซ้อนกัน) ข้ามไป

  const lot = lots[idx];
  const amount = lot.qty * price;
  if (amount <= 0.01) return null;
  const fee = amount * feeRate;

  lots.splice(idx, 1);
  let btc = ledger.btc - lot.qty;
  const cash = ledger.cash + amount - fee;
  if (btc < 1e-9) btc = 0;
  const lotsTotalCost = lots.reduce((a, l) => a + l.qty * l.price, 0);
  const avgEntry = btc > 0 ? lotsTotalCost / btc : 0;

  return { ledger: { cash, btc, avgEntry, lots, orders: ledger.orders || [] }, amount, fee, qty: lot.qty };
}

async function processMarket(db, market, price) {
  if (!price) {
    console.log(`[${market}] no price available, skipping`);
    return;
  }
  const feeRate = FEE_RATES[market];
  const ledgerKey = LEDGER_KEY[market];
  const usersSnap = await db.collection("users").get();
  console.log(`[${market}] price=${price} checking ${usersSnap.size} users`);

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const data = userDoc.data();
    const ledger = data[ledgerKey];
    if (!ledger || !ledger.orders || !ledger.orders.length) continue;

    for (const order of ledger.orders) {
      const hit = (order.side === "buy" && price <= order.targetPrice) || (order.side === "sell" && price >= order.targetPrice);
      if (!hit) continue;

      const userRef = db.collection("users").doc(uid);
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(userRef);
          const fresh = snap.data();
          const freshLedger = fresh[ledgerKey];
          if (!freshLedger || !freshLedger.orders) return;
          const stillThere = freshLedger.orders.find((o) => o.id === order.id);
          if (!stillThere) return; // มีคนอื่น (client หรือรันก่อนหน้า) ทำไปแล้ว

          const remainingOrders = freshLedger.orders.filter((o) => o.id !== order.id);
          const result = applyTrade(freshLedger, order.side, order.amount, price, feeRate);
          if (!result) {
            // เงิน/เหรียญไม่พอจริงๆ ตอนนี้ ตัดคำสั่งทิ้งเฉยๆ ไม่ยิงเทรด
            tx.update(userRef, { [`${ledgerKey}.orders`]: remainingOrders });
            return;
          }

          const equity = result.ledger.cash + result.ledger.btc * price;
          const updatePayload = {
            [`${ledgerKey}.cash`]: result.ledger.cash,
            [`${ledgerKey}.btc`]: result.ledger.btc,
            [`${ledgerKey}.avgEntry`]: result.ledger.avgEntry,
            [`${ledgerKey}.lots`]: result.ledger.lots,
            [`${ledgerKey}.orders`]: remainingOrders,
          };
          if (order.side === "sell") {
            updatePayload[`${ledgerKey}.lastSell`] = { price, usd: result.amount, qty: result.qty, ts: Date.now() };
          }
          tx.update(userRef, updatePayload);

          const tradeRef = db.collection("trades").doc();
          tx.set(tradeRef, {
            uid,
            email: fresh.email || null,
            market,
            ccy: ledgerKey,
            side: order.side,
            price,
            qty: result.qty,
            usd: result.amount,
            fee: result.fee,
            equityAfter: equity,
            reason: `คำสั่งรอราคาที่ตั้งไว้ทำงาน: ${order.side === "buy" ? "ราคาลงถึง" : "ราคาขึ้นถึง"}เป้าหมาย ${round2(order.targetPrice)} จึง${order.side === "buy" ? "ซื้อ" : "ขาย"}ให้ตามที่ตั้งไว้`,
            ts: Timestamp.now(),
          });

          const logRef = db.collection("logs").doc();
          tx.set(logRef, {
            uid,
            email: fresh.email || null,
            type: "order_triggered",
            detail: {
              market,
              side: order.side,
              targetPrice: Math.round(order.targetPrice * 100) / 100,
              amount: Math.round(result.amount * 100) / 100,
              source: "background",
            },
            ts: Timestamp.now(),
          });
        });
        console.log(`[${market}] executed order ${order.id} (${order.side} @ ${order.targetPrice}) for user ${uid}`);
      } catch (err) {
        console.error(`[${market}] failed to execute order ${order.id} for user ${uid}:`, err.message);
      }
    }
  }
}

// ออโต้เทรด DCA — ซื้อ BTC จำนวนคงที่ตามรอบเวลาที่ผู้ใช้ตั้งไว้ ไม่สนราคาขึ้นลง (เก็บสะสม BTC ระยะยาว)
async function processDCA(db, market, price) {
  if (!price) {
    console.log(`[dca:${market}] no price available, skipping`);
    return;
  }
  const feeRate = FEE_RATES[market];
  const ledgerKey = LEDGER_KEY[market];
  const usersSnap = await db.collection("users").get();
  const now = Date.now();
  let count = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const data = userDoc.data();
    const ledger = data[ledgerKey];
    const dca = ledger && ledger.dca;
    if (!dca || !dca.enabled || !(dca.amount > 0)) continue;
    const intervalMs = (dca.intervalHours || 24) * 3600 * 1000;
    const last = dca.lastRun || 0;
    if (now - last < intervalMs) continue;

    const userRef = db.collection("users").doc(uid);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const fresh = snap.data();
        const freshLedger = fresh[ledgerKey];
        const freshDca = freshLedger && freshLedger.dca;
        if (!freshDca || !freshDca.enabled || !(freshDca.amount > 0)) return;
        const freshLast = freshDca.lastRun || 0;
        if (now - freshLast < intervalMs) return; // อีก instance ทำไปแล้ว

        const result = applyTrade(freshLedger, "buy", freshDca.amount, price, feeRate);
        const newDca = { enabled: freshDca.enabled, amount: freshDca.amount, intervalHours: freshDca.intervalHours, lastRun: now };
        if (!result) {
          // เงินไม่พอตอนนี้ ข้ามรอบนี้ไปก่อน แต่อัปเดต lastRun กันไม่ให้เช็คซ้ำถี่เกิน
          tx.update(userRef, { [`${ledgerKey}.dca`]: newDca });
          return;
        }

        const equity = result.ledger.cash + result.ledger.btc * price;
        tx.update(userRef, {
          [`${ledgerKey}.cash`]: result.ledger.cash,
          [`${ledgerKey}.btc`]: result.ledger.btc,
          [`${ledgerKey}.avgEntry`]: result.ledger.avgEntry,
          [`${ledgerKey}.lots`]: result.ledger.lots,
          [`${ledgerKey}.dca`]: newDca,
        });

        const tradeRef = db.collection("trades").doc();
        tx.set(tradeRef, {
          uid,
          email: fresh.email || null,
          market,
          ccy: ledgerKey,
          side: "buy",
          price,
          qty: result.qty,
          usd: result.amount,
          fee: result.fee,
          equityAfter: equity,
          dca: true,
          reason: `DCA อัตโนมัติ: ครบรอบ ${freshDca.intervalHours} ชั่วโมง จึงซื้อ ${round2(result.amount)} ตามที่ตั้งไว้ ไม่สนราคาขึ้นลง`,
          ts: Timestamp.now(),
        });

        const logRef = db.collection("logs").doc();
        tx.set(logRef, {
          uid,
          email: fresh.email || null,
          type: "dca_triggered",
          detail: {
            market,
            amount: Math.round(result.amount * 100) / 100,
            intervalHours: freshDca.intervalHours,
            source: "background",
          },
          ts: Timestamp.now(),
        });
      });
      count++;
      console.log(`[dca:${market}] executed for user ${uid}`);
    } catch (err) {
      console.error(`[dca:${market}] failed for user ${uid}:`, err.message);
    }
  }
  console.log(`[dca:${market}] done, ${count} executed`);
}

// สรุปว่าใช้เทคนิคไหนบ้างและค่าที่ได้ตอนตัดสินใจครั้งนี้ — บันทึกลง logs ทุกครั้งที่เทรด เพื่อย้อนดูทีหลังว่า
// เทคนิคไหนช่วย/ทำให้พลาดบ่อย จะได้เอาไปปรับปรุงโมเดล (ถ่วงน้ำหนักเทคนิคใหม่, ตัดเทคนิคที่ไม่ช่วย ฯลฯ)
function signalSummary(signal) {
  const techniques = [];
  if (signal.forecast) {
    techniques.push({
      name: "monte_carlo_forecast",
      probUp: Math.round(signal.forecast.probUp * 100) / 100,
      p10: Math.round(signal.forecast.p10 * 100) / 100,
      p90: Math.round(signal.forecast.p90 * 100) / 100,
    });
  }
  if (signal.rsi != null) {
    techniques.push({ name: "rsi_14", value: Math.round(signal.rsi * 10) / 10, overbought: signal.overbought, oversold: signal.oversold });
  }
  if (signal.trendUp != null) {
    techniques.push({ name: "ema_9_21_trend", trendUp: signal.trendUp, emaFast: Math.round(signal.emaFast * 100) / 100, emaSlow: Math.round(signal.emaSlow * 100) / 100 });
  }
  if (signal.bb) {
    techniques.push({ name: "bollinger_bands_20_2", nearUpperBand: signal.nearUpperBand, nearLowerBand: signal.nearLowerBand, upper: Math.round(signal.bb.upper * 100) / 100, lower: Math.round(signal.bb.lower * 100) / 100 });
  }
  if (signal.macd) {
    techniques.push({ name: "macd_12_26_9", histogram: Math.round(signal.macd.histogram * 100) / 100, bearish: signal.macdBearish, bullish: signal.macdBullish });
  }
  return { techniques, bearishVotes: signal.bearishVotes, bullishVotes: signal.bullishVotes, totalVotes: signal.totalVotes, bearish: signal.bearish, bullish: signal.bullish };
}
// ออโต้เทรดอัตโนมัติ 100% — ตัดสินใจเองทั้งซื้อและขาย โดยให้คะแนนถ่วงน้ำหนักจากหลายเทคนิค (ดู shared/strategy.mjs)
// เป้าหมายคือ "จำนวน BTC ที่เพิ่มขึ้น" ทั้งระยะสั้นและระยะยาว จึงแบ่งเงินเป็น 2 ขา:
//   core  = สะสมระยะยาว ทยอยซื้อเก็บเรื่อยๆ ไม่ขายออกอัตโนมัติ (จำนวนเหรียญโตตามเวลา)
//   swing = เทรดสั้น ขายตอนแพง ซื้อคืนตอนถูก โดยบังคับให้ซื้อคืนได้เหรียญมากกว่าที่ขายไปเสมอ
// ทุกการตัดสินใจ (รวม "ไม่ทำอะไร") ถูกบันทึกลง logs พร้อมเหตุผลภาษาไทย ให้แอดมินย้อนอ่านและเอาไปปรับกลยุทธ์ได้
async function processAutoTrade(db, market, price, candles) {
  if (!price || !candles || candles.length < 30) {
    console.log(`[auto:${market}] no price/candles, skipping`);
    return;
  }
  const feeRate = FEE_RATES[market];
  const ledgerKey = LEDGER_KEY[market];
  const returns = computeReturns(candles);
  // เรียนรู้จากข้อมูลเก่าก่อน: วัดว่าอินดิเคเตอร์ตัวไหนเคยทายถูกจริงบนแท่งย้อนหลัง แล้วปรับน้ำหนักตามนั้น
  const learned = evaluateIndicators(candles, 20, 60);
  const analysis = scoreMarket(price, candles, returns, learned);
  const score = analysis.composite;
  const verdict = describeScore(score);

  console.log(`[auto:${market}] price=${price} score=${score.toFixed(1)} (${verdict}) atr%=${analysis.atrPct ? analysis.atrPct.toFixed(3) : "n/a"}`);
  if (learned) console.log(`[auto:${market}] ${describeLearning(learned)}`);

  const usersSnap = await db.collection("users").get();
  const now = Date.now();
  let sellCount = 0, buyCount = 0, holdCount = 0;

  // ข้อมูลอินดิเคเตอร์ชุดเดียวกันแนบไปกับ log ทุกใบ เพื่อให้ย้อนวิเคราะห์ได้ว่าตอนนั้นตลาดเป็นยังไง
  const marketSnapshot = {
    price: round2(price),
    score: round2(score),
    verdict,
    atrPct: analysis.atrPct != null ? round2(analysis.atrPct) : null,
    percentB: analysis.pctB != null ? round2(analysis.pctB) : null,
    roc10: analysis.roc != null ? round2(analysis.roc) : null,
    indicators: analysis.parts.map((p) => ({
      name: p.key, score: round2(p.score), weight: p.weight, note: p.text,
    })),
    legacyVotes: signalSummary(analysis.signal),
    learning: learned ? { horizon: learned.horizon, samples: learned.samples, indicators: learned.indicators, summary: describeLearning(learned) } : null,
  };

  async function writeDecision(tx, uid, email, action, reasonText, extra) {
    const logRef = db.collection("logs").doc();
    tx.set(logRef, {
      uid, email: email || null,
      type: "auto_decision",
      detail: Object.assign({ market, action, reason: reasonText, market_analysis: marketSnapshot, source: "background" }, extra || {}),
      ts: Timestamp.now(),
    });
  }

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const data = userDoc.data();
    const ledger = data[ledgerKey];
    const autoTrade = ledger && ledger.autoTrade;
    if (!autoTrade || !autoTrade.enabled) continue;
    const userRef = db.collection("users").doc(uid);
    let didSomething = false;

    // ---------- 1) ขา swing: พิจารณาขายทำกำไร ----------
    // ขายเมื่อ (ก) ถึงเป้ากำไรที่ตั้งไว้ หรือ (ข) มีกำไรแล้วและสัญญาณเอนขาลงชัด (ล็อกกำไรก่อนโดนกลืน)
    // หรือ (ค) ขาดทุนหนักและขาลงชัดเจนจริงๆ (ตัดขาดทุน)
    let keepChecking = true, guard = 0;
    while (keepChecking && guard < 30) {
      keepChecking = false; guard++;
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(userRef);
          const fresh = snap.data();
          const fl = fresh[ledgerKey];
          const fa = fl && fl.autoTrade;
          if (!fa || !fa.enabled || !fl.lots || !fl.lots.length) return;

          // ขา core ไม่ขายอัตโนมัติ — คัดเฉพาะไม้ swing
          const swingLots = fl.lots.filter((l) => l.sleeve !== "core");
          if (!swingLots.length) return;

          let lot = null, why = null, reasonText = null;
          for (const l of swingLots) {
            const targetSell = l.price * (1 + PROFIT_TARGET) / (1 - feeRate);
            const stopLoss = l.price * (1 - STOP_LOSS_PCT);
            const pnlPct = (price / l.price - 1) * 100;
            const netPnlPct = (price * (1 - feeRate) / (l.price * (1 + feeRate)) - 1) * 100;

            if (price >= targetSell) {
              lot = l; why = "profit_target";
              reasonText = `ขายทำกำไรตามเป้า: ไม้นี้ซื้อไว้ที่ ${round2(l.price)} ตอนนี้ราคา ${round2(price)} (+${pnlPct.toFixed(2)}%) ผ่านเป้าหมาย ${(PROFIT_TARGET * 100).toFixed(1)}% หลังหักค่าธรรมเนียมแล้ว จึงขายล็อกกำไรไว้ก่อน แล้วรอซื้อคืนตอนราคาย่อเพื่อให้ได้เหรียญกลับมามากกว่าเดิม`;
              break;
            }
            if (netPnlPct > 0.3 && score <= THRESHOLDS.strongSell) {
              lot = l; why = "lock_profit_bearish";
              reasonText = `ขายล็อกกำไรก่อนขาลง: ไม้นี้ซื้อที่ ${round2(l.price)} ตอนนี้กำไรสุทธิ +${netPnlPct.toFixed(2)}% แม้ยังไม่ถึงเป้า ${(PROFIT_TARGET * 100).toFixed(1)}% แต่คะแนนรวมตกลงมาที่ ${score.toFixed(1)} (${verdict}) จึงรีบเก็บกำไรไว้ก่อนที่ราคาจะย้อนกลับลงไปกินกำไรที่มีอยู่`;
              break;
            }
            if (price <= stopLoss && score <= THRESHOLDS.strongSell) {
              lot = l; why = "stop_loss";
              reasonText = `ตัดขาดทุน: ไม้นี้ซื้อที่ ${round2(l.price)} ตอนนี้ราคา ${round2(price)} (${pnlPct.toFixed(2)}%) ขาดทุนเกินเกณฑ์ ${(STOP_LOSS_PCT * 100).toFixed(0)}% และคะแนนรวม ${score.toFixed(1)} ยืนยันว่าเป็นขาลงชัดเจน จึงตัดขาดทุนเพื่อเอาเงินสดไปรอซื้อคืนที่ราคาต่ำกว่า (ได้เหรียญกลับมามากกว่าถือค้างไว้)`;
              break;
            }
          }
          if (!lot) return;

          const result = sellSpecificLot(fl, lot, price, feeRate);
          if (!result) return;
          const equity = result.ledger.cash + result.ledger.btc * price;
          const lastSell = { price, usd: result.amount, qty: result.qty, ts: now };

          tx.update(userRef, {
            [`${ledgerKey}.cash`]: result.ledger.cash,
            [`${ledgerKey}.btc`]: result.ledger.btc,
            [`${ledgerKey}.avgEntry`]: result.ledger.avgEntry,
            [`${ledgerKey}.lots`]: result.ledger.lots,
            [`${ledgerKey}.lastSell`]: lastSell,
          });

          const tradeRef = db.collection("trades").doc();
          tx.set(tradeRef, {
            uid, email: fresh.email || null, market, ccy: ledgerKey, side: "sell",
            price, qty: result.qty, usd: result.amount, fee: result.fee, equityAfter: equity,
            autoTrade: true, sleeve: "swing", trigger: why, reason: reasonText, ts: Timestamp.now(),
          });

          await writeDecision(tx, uid, fresh.email, "sell", reasonText, {
            trigger: why,
            lotBoughtAt: round2(lot.price),
            btcSold: result.qty,
            proceeds: round2(result.amount),
            pnlPct: round2((price / lot.price - 1) * 100),
            nextStep: `ตั้งเพดานซื้อคืนไว้ที่ ${round2(btcAccumCeiling(price, feeRate, BTC_ACCUM_TARGET))} — จะซื้อคืนก็ต่อเมื่อราคาลงต่ำกว่านี้ เพื่อให้ได้เหรียญเพิ่มอย่างน้อย ${(BTC_ACCUM_TARGET * 100).toFixed(1)}%`,
          });

          sellCount++; didSomething = true;
          keepChecking = true;
        });
      } catch (err) {
        console.error(`[auto:${market}] sell failed for ${uid}:`, err.message);
        keepChecking = false;
      }
    }

    // ---------- 2) พิจารณาซื้อ (ทั้งขา swing และขา core) ----------
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const fresh = snap.data();
        const fl = fresh[ledgerKey];
        const fa = fl && fl.autoTrade;
        if (!fa || !fa.enabled) return;

        const cash = fl.cash || 0;
        const lastSell = fl.lastSell;
        const minTicket = market === "bitkub" ? 20 : 1; // ไม้เล็กกว่านี้ไม่คุ้มค่าธรรมเนียม
        const blockers = [];

        // 2a) ถ้ามีเงินค้างจากการขายรอบก่อน -> ต้องซื้อคืนให้ได้เหรียญมากกว่าเดิมเท่านั้น
        if (lastSell && lastSell.qty > 0) {
          const ceiling = btcAccumCeiling(lastSell.price, feeRate, BTC_ACCUM_TARGET);
          if (price > ceiling) {
            const gapPct = (price / ceiling - 1) * 100;
            await writeDecision(tx, uid, fresh.email, "hold",
              `รอซื้อคืน: ขายไปแล้ว ${lastSell.qty.toFixed(8)} BTC ที่ราคา ${round2(lastSell.price)} ตอนนี้ราคา ${round2(price)} ยังสูงกว่าเพดานซื้อคืน ${round2(ceiling)} อยู่ ${gapPct.toFixed(2)}% ถ้าซื้อคืนตอนนี้จะได้เหรียญน้อยกว่าที่ขายไป (เสียให้ค่าธรรมเนียม 2 ขา) จึงถือเงินสดรอให้ราคาย่อลงมาก่อน`,
              { trigger: "waiting_rebuy", rebuyCeiling: round2(ceiling), gapToCeilingPct: round2(gapPct), cashIdle: round2(cash) });
            holdCount++;
            return;
          }
          // ราคาถึงเพดานแล้ว -> ซื้อคืนด้วยเงินจากการขายรอบนั้นพอดี
          const buyAmount = (lastSell.usd * (1 - feeRate)) / (1 + feeRate);
          const result = applyTrade(fl, "buy", buyAmount, price, feeRate);
          if (!result) return;
          const btcDelta = result.qty - lastSell.qty;
          const newAuto = Object.assign({}, fa, {
            lastBuyAt: now,
            roundTrips: (fa.roundTrips || 0) + 1,
            btcAccumulated: (fa.btcAccumulated || 0) + btcDelta,
          });
          const equity = result.ledger.cash + result.ledger.btc * price;

          tx.update(userRef, {
            [`${ledgerKey}.cash`]: result.ledger.cash,
            [`${ledgerKey}.btc`]: result.ledger.btc,
            [`${ledgerKey}.avgEntry`]: result.ledger.avgEntry,
            [`${ledgerKey}.lots`]: result.ledger.lots,
            [`${ledgerKey}.autoTrade`]: newAuto,
            [`${ledgerKey}.lastSell`]: null,
          });
          const rebuyReason = `ซื้อคืนปิดรอบสำเร็จ: ราคาลงมาที่ ${round2(price)} ต่ำกว่าเพดาน ${round2(btcAccumCeiling(lastSell.price, feeRate, BTC_ACCUM_TARGET))} แล้ว จึงซื้อคืนด้วยเงินที่ได้จากการขายรอบนั้น ขายไป ${lastSell.qty.toFixed(8)} BTC ซื้อกลับได้ ${result.qty.toFixed(8)} BTC เพิ่มขึ้น ${btcDelta >= 0 ? "+" : ""}${(result.qty / lastSell.qty * 100 - 100).toFixed(3)}% — นี่คือกำไรที่เป็นจำนวนเหรียญจริง`;
          const tradeRef = db.collection("trades").doc();
          tx.set(tradeRef, {
            uid, email: fresh.email || null, market, ccy: ledgerKey, side: "buy",
            price, qty: result.qty, usd: result.amount, fee: result.fee, equityAfter: equity,
            autoTrade: true, sleeve: "swing", trigger: "rebuy_complete", reason: rebuyReason, ts: Timestamp.now(),
          });
          await writeDecision(tx, uid, fresh.email, "buy", rebuyReason,
            {
              trigger: "rebuy_complete", sleeve: "swing",
              btcSold: lastSell.qty, btcBought: result.qty, btcDelta,
              btcDeltaPct: round2((result.qty / lastSell.qty - 1) * 100),
              roundTrips: newAuto.roundTrips, btcAccumulatedTotal: newAuto.btcAccumulated,
            });
          buyCount++; didSomething = true;
          return;
        }

        // 2b) ไม่มีเงินค้างรอซื้อคืน -> พิจารณาเปิดไม้ใหม่ตามคะแนนสัญญาณ
        if (cash < minTicket) {
          await writeDecision(tx, uid, fresh.email, "hold",
            `ไม่ซื้อ: เงินสดคงเหลือ ${round2(cash)} น้อยเกินกว่าจะเปิดไม้ใหม่ได้ (ขั้นต่ำ ${minTicket}) — เงินถูกแปลงเป็น BTC ไปเกือบหมดแล้ว ระบบจะรอจังหวะขายทำกำไรเพื่อให้มีเงินสดกลับมาหมุนต่อ`,
            { trigger: "no_cash", cash: round2(cash) });
          holdCount++;
          return;
        }

        const coreDue = now - (fa.lastCoreBuyAt || 0) >= CORE_BUY_INTERVAL_MS;

        // ขา core: ทยอยสะสมระยะยาวเป็นรอบเวลา ตราบใดที่ไม่ใช่ขาลงรุนแรง
        if (coreDue && score > THRESHOLDS.strongSell) {
          const coreAmount = Math.max(minTicket, cash * CORE_BUY_FRACTION);
          const result = applyTrade(fl, "buy", coreAmount, price, feeRate);
          if (result) {
            // ทำเครื่องหมายไม้ล่าสุดเป็นขา core เพื่อไม่ให้ระบบขายออกอัตโนมัติ
            const lots = result.ledger.lots.slice();
            lots[lots.length - 1] = Object.assign({}, lots[lots.length - 1], { sleeve: "core" });
            const newAuto = Object.assign({}, fa, { lastCoreBuyAt: now });
            const equity = result.ledger.cash + result.ledger.btc * price;
            tx.update(userRef, {
              [`${ledgerKey}.cash`]: result.ledger.cash,
              [`${ledgerKey}.btc`]: result.ledger.btc,
              [`${ledgerKey}.avgEntry`]: result.ledger.avgEntry,
              [`${ledgerKey}.lots`]: lots,
              [`${ledgerKey}.autoTrade`]: newAuto,
            });
            const coreReason = `สะสมระยะยาว (core): ครบรอบสะสม ${(CORE_BUY_INTERVAL_MS / 3600000).toFixed(0)} ชั่วโมง และคะแนนรวม ${score.toFixed(1)} (${verdict}) ไม่ได้เป็นขาลงรุนแรง จึงทยอยซื้อเก็บ ${round2(result.amount)} (${(CORE_BUY_FRACTION * 100).toFixed(0)}% ของเงินสด) ได้ ${result.qty.toFixed(8)} BTC — ไม้ขานี้จะไม่ถูกขายอัตโนมัติ เก็บสะสมให้จำนวนเหรียญโตขึ้นระยะยาว`;
            const tradeRef = db.collection("trades").doc();
            tx.set(tradeRef, {
              uid, email: fresh.email || null, market, ccy: ledgerKey, side: "buy",
              price, qty: result.qty, usd: result.amount, fee: result.fee, equityAfter: equity,
              autoTrade: true, sleeve: "core", trigger: "core_dca", reason: coreReason, ts: Timestamp.now(),
            });
            await writeDecision(tx, uid, fresh.email, "buy", coreReason,
              { trigger: "core_dca", sleeve: "core", btcBought: result.qty, amount: round2(result.amount) });
            buyCount++; didSomething = true;
            return;
          }
        }

        // ขา swing: ซื้อเมื่อคะแนนถึงเกณฑ์ — ไม่มีคูลดาวน์ กันพลาดจังหวะที่สัญญาณมาแล้วหายเร็ว
        // (ไม่ใช่ปัญหาซื้อรัวไม่รู้จบ เพราะแต่ละครั้งใช้สัดส่วนของเงินสด "ที่เหลือ" ยิ่งซื้อถี่ ก้อนเงินยิ่งเล็กลงเอง)
        if (score < THRESHOLDS.weakBuy) blockers.push(`คะแนนรวม ${score.toFixed(1)} ยังต่ำกว่าเกณฑ์ซื้อ ${THRESHOLDS.weakBuy}`);

        // กันอาการ "ซื้อกองที่ราคาเดียวกัน" — ที่ผ่านมาเคยเปิด 7 ไม้ในชั่วโมงเดียวที่ราคาแทบเท่ากัน
        // กลายเป็นก้อนใหญ่ก้อนเดียวที่ขึ้นลงพร้อมกันหมด ไม่ได้กระจายจังหวะเข้าจริง
        // (เป็นการกันความเสี่ยงเชิงโครงสร้าง ไม่ใช่เพื่อเพิ่มผลตอบแทน — ทดสอบแล้วผลตอบแทนพอๆ เดิม)
        const openSwing = (fl.lots || []).filter((l) => l.sleeve !== "core");
        if (openSwing.length >= MAX_OPEN_SWING) {
          blockers.push(`มีไม้ swing เปิดอยู่ ${openSwing.length} ไม้แล้ว (เพดาน ${MAX_OPEN_SWING})`);
        } else if (openSwing.some((l) => Math.abs(price / l.price - 1) * 100 < MIN_SWING_SEPARATION_PCT)) {
          blockers.push(`ราคาตอนนี้ใกล้กับไม้ที่ถืออยู่แล้ว (ห่างไม่ถึง ${MIN_SWING_SEPARATION_PCT}%) รอให้ราคาขยับก่อนค่อยเปิดไม้ใหม่`);
        }

        if (blockers.length) {
          const topReasons = analysis.parts.slice().sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight)).slice(0, 3);
          await writeDecision(tx, uid, fresh.email, "hold",
            `ยังไม่เข้าเงื่อนไขซื้อ: ${blockers.join(" และ ")} — สรุปสภาพตลาดตอนนี้: ${verdict} (คะแนน ${score.toFixed(1)}) ปัจจัยที่มีน้ำหนักที่สุดคือ ${topReasons.map((r) => r.text).join(" | ")}`,
            { trigger: "below_threshold", blockers, cash: round2(cash) });
          holdCount++;
          return;
        }

        const frac = positionFraction(score, analysis.atrPct);
        const amount = Math.max(minTicket, cash * frac);
        const result = applyTrade(fl, "buy", amount, price, feeRate);
        if (!result) return;
        const newAuto = Object.assign({}, fa, { lastBuyAt: now });
        const equity = result.ledger.cash + result.ledger.btc * price;
        tx.update(userRef, {
          [`${ledgerKey}.cash`]: result.ledger.cash,
          [`${ledgerKey}.btc`]: result.ledger.btc,
          [`${ledgerKey}.avgEntry`]: result.ledger.avgEntry,
          [`${ledgerKey}.lots`]: result.ledger.lots,
          [`${ledgerKey}.autoTrade`]: newAuto,
        });
        const topReasons = analysis.parts.slice().sort((a, b) => b.score * b.weight - a.score * a.weight).slice(0, 3);
        const swingReason = `เปิดไม้เทรดสั้น (swing): คะแนนรวม ${score.toFixed(1)} = ${verdict} ผ่านเกณฑ์ซื้อ ${THRESHOLDS.weakBuy} จึงลงเงิน ${round2(result.amount)} (${(frac * 100).toFixed(0)}% ของเงินสด ปรับขนาดตามความมั่นใจและความผันผวน ATR ${analysis.atrPct ? analysis.atrPct.toFixed(2) + "%" : "n/a"}) ได้ ${result.qty.toFixed(8)} BTC — เหตุผลหลักที่เข้าซื้อ: ${topReasons.map((r) => r.text).join(" | ")} — จะขายทำกำไรเมื่อราคาขึ้นถึง ${round2(price * (1 + PROFIT_TARGET) / (1 - feeRate))}`;
        const tradeRef = db.collection("trades").doc();
        tx.set(tradeRef, {
          uid, email: fresh.email || null, market, ccy: ledgerKey, side: "buy",
          price, qty: result.qty, usd: result.amount, fee: result.fee, equityAfter: equity,
          autoTrade: true, sleeve: "swing", trigger: "signal_buy", reason: swingReason, ts: Timestamp.now(),
        });
        await writeDecision(tx, uid, fresh.email, "buy", swingReason,
          {
            trigger: "signal_buy", sleeve: "swing",
            btcBought: result.qty, amount: round2(result.amount),
            positionFractionPct: round2(frac * 100),
            targetSellPrice: round2(price * (1 + PROFIT_TARGET) / (1 - feeRate)),
          });
        buyCount++; didSomething = true;
      });
    } catch (err) {
      console.error(`[auto:${market}] buy failed for ${uid}:`, err.message);
    }

    if (!didSomething) {
      // ไม่มีทั้งซื้อและขาย และยังไม่ได้บันทึกเหตุผลไว้ (เช่นแค่ถือไม้รอราคาขึ้น) -> บันทึกสถานะการถือไว้ด้วย
      try {
        const snap = await userRef.get();
        const fl = snap.data()[ledgerKey];
        if (fl && fl.lots && fl.lots.length && !(fl.lastSell && fl.lastSell.qty > 0)) {
          const swingLots = fl.lots.filter((l) => l.sleeve !== "core");
          if (swingLots.length) {
            const nearest = swingLots.reduce((best, l) => {
              const t = l.price * (1 + PROFIT_TARGET) / (1 - feeRate);
              return !best || t < best.target ? { lot: l, target: t } : best;
            }, null);
            const distPct = (nearest.target / price - 1) * 100;
            await db.collection("logs").add({
              uid, email: data.email || null, type: "auto_decision",
              detail: {
                market, action: "hold", source: "background", trigger: "holding_position",
                reason: `ถือไม้รอราคาขึ้น: มีไม้เทรดสั้นค้างอยู่ ${swingLots.length} ไม้ ไม้ที่ใกล้ถึงเป้าที่สุดซื้อไว้ที่ ${round2(nearest.lot.price)} ต้องรอราคาขึ้นไปถึง ${round2(nearest.target)} (อีก ${distPct.toFixed(2)}%) ถึงจะขายทำกำไร ตอนนี้ราคา ${round2(price)} คะแนนรวม ${score.toFixed(1)} (${verdict}) ยังไม่เข้าเงื่อนไขขาย`,
                market_analysis: marketSnapshot,
                openSwingLots: swingLots.length,
                nearestTarget: round2(nearest.target),
                distanceToTargetPct: round2(distPct),
              },
              ts: Timestamp.now(),
            });
            holdCount++;
          }
        }
      } catch (err) {
        console.error(`[auto:${market}] hold log failed for ${uid}:`, err.message);
      }
    }
  }
  console.log(`[auto:${market}] done, ${sellCount} sells, ${buyCount} buys, ${holdCount} holds logged`);
}


async function main() {
  const app = initializeApp({ credential: cert(getServiceAccount()) });
  const db = getFirestore(app);

  const [binancePrice, bitkubPrice, binanceCandles, bitkubCandles] = await Promise.all([
    fetchBinancePrice().catch((e) => { console.error("binance price fetch failed", e.message); return null; }),
    fetchBitkubPrice().catch((e) => { console.error("bitkub price fetch failed", e.message); return null; }),
    fetchBinanceCandles(),
    fetchBitkubCandles(),
  ]);

  await processMarket(db, "binance", binancePrice);
  await processMarket(db, "bitkub", bitkubPrice);
  await processDCA(db, "binance", binancePrice);
  await processDCA(db, "bitkub", bitkubPrice);
  await processAutoTrade(db, "binance", binancePrice, binanceCandles);
  await processAutoTrade(db, "bitkub", bitkubPrice, bitkubCandles);

  console.log("done");
}

// ส่งออกไว้สำหรับการทดสอบแบบ unit test เฉพาะจุด (scripts/_unit-test-*.mjs) — ไม่กระทบการรันจริงผ่าน main()
export { applyTrade, sellSpecificLot };

// รันเฉพาะตอนเรียกไฟล์นี้ตรงๆ (node scripts/check-orders.mjs) ไม่ใช่ตอน import ไปทดสอบ
if (process.argv[1] && process.argv[1].endsWith("check-orders.mjs")) {
  main().catch((err) => {
    console.error("check-orders failed:", err);
    process.exit(1);
  });
}
