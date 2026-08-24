// รันโดย GitHub Actions ตามตารางเวลา (cron) — เช็คคำสั่งรอราคาของทุกผู้ใช้แล้วยิงคำสั่งซื้อ/ขายอัตโนมัติ
// ให้แม้ผู้ใช้จะไม่ได้เปิดหน้าเว็บค้างไว้ก็ตาม (ทำงานฝั่งเซิร์ฟเวอร์ผ่าน Firebase Admin SDK)
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { computeReturns, computeSignal } from "../shared/signals.mjs";

const FEE_RATES = { binance: 0.001, bitkub: 0.0025 };
const LEDGER_KEY = { binance: "usd", bitkub: "thb" };
const PROFIT_TARGET = 0.02; // เป้าหมายกำไรขั้นต่ำต่อรอบ 2% (ตรงกับฝั่งเว็บ)
const STOP_LOSS_PCT = 0.02; // ตัดขาดทุนเมื่อขาดทุนเกิน 2% และสัญญาณยืนยันว่าเป็นขาลง
const AUTO_TRADE_BUY_COOLDOWN_MS = 60 * 60 * 1000; // ห่างกันอย่างน้อย 1 ชม.ต่อการซื้ออัตโนมัติ 1 ครั้ง กันซื้อรัวทุก 5 นาทีตอนราคานิ่งต่ำกว่าเป้า
const KLINE_LIMIT = 120;

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
  try {
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=${KLINE_LIMIT}`);
    if (!res.ok) throw new Error("binance klines http " + res.status);
    const data = await res.json();
    return data.map((k) => ({ t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]) }));
  } catch (err) {
    console.warn("binance klines fetch failed (likely geo-block), auto-trade signal unavailable this run:", err.message);
    return null;
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

// ออโต้เทรดเต็มรูปแบบ — ใช้สัญญาณรวม (Monte Carlo + RSI + EMA trend + Bollinger Bands) ตัดสินใจซื้อ/ขายเอง
// ซื้อ: อ้างอิงจุดซื้อแบบเดียวกับฝั่งเว็บ (ต่ำกว่าราคาขายล่าสุด หรือแนวรับที่คาดการณ์) + ต้องไม่ overbought ด้วย
// ขาย: ขายทำกำไรเมื่อถึงเป้าหมาย 2% ต่อรอบ (FIFO) หรือตัดขาดทุนเมื่อขาดทุนเกิน 2% และสัญญาณยืนยันเป็นขาลง (confluence)
async function processAutoTrade(db, market, price, candles) {
  if (!price || !candles || candles.length < 25) {
    console.log(`[auto:${market}] no price/candles, skipping`);
    return;
  }
  const feeRate = FEE_RATES[market];
  const ledgerKey = LEDGER_KEY[market];
  const returns = computeReturns(candles);
  const signal = computeSignal(price, candles, returns);
  if (!signal.forecast) {
    console.log(`[auto:${market}] not enough data for signal, skipping`);
    return;
  }
  console.log(`[auto:${market}] price=${price} bearish=${signal.bearish} bullish=${signal.bullish} rsi=${signal.rsi ? signal.rsi.toFixed(1) : "n/a"} probUp=${signal.forecast.probUp.toFixed(2)}`);

  const usersSnap = await db.collection("users").get();
  const now = Date.now();
  let sellCount = 0, buyCount = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const data = userDoc.data();
    const ledger = data[ledgerKey];
    const autoTrade = ledger && ledger.autoTrade;
    if (!autoTrade || !autoTrade.enabled) continue;
    const userRef = db.collection("users").doc(uid);

    // 1) เช็คขายทำกำไร/ตัดขาดทุน ทีละรอบ (FIFO เก่าสุดก่อน) — ทำได้หลายรอบต่อการรันครั้งเดียว
    let keepChecking = true;
    while (keepChecking) {
      keepChecking = false;
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(userRef);
          const fresh = snap.data();
          const freshLedger = fresh[ledgerKey];
          const freshAuto = freshLedger && freshLedger.autoTrade;
          if (!freshAuto || !freshAuto.enabled || !freshLedger.lots || !freshLedger.lots.length) return;

          const lot = freshLedger.lots[0]; // เก่าสุด (FIFO)
          const targetSell = lot.price * (1 + PROFIT_TARGET) / (1 - feeRate);
          const stopLoss = lot.price * (1 - STOP_LOSS_PCT);
          const atTarget = price >= targetSell;
          const atRisk = !atTarget && signal.bearish && price <= stopLoss;
          if (!atTarget && !atRisk) return;

          const result = applyTrade(freshLedger, "sell", lot.qty * price, price, feeRate);
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
            autoTrade: true, ts: Timestamp.now(),
          });

          const logRef = db.collection("logs").doc();
          tx.set(logRef, {
            uid, email: fresh.email || null, type: "auto_trade_triggered",
            detail: {
              market, side: "sell", reason: atTarget ? "profit_target" : "stop_loss",
              price: Math.round(price * 100) / 100, amount: Math.round(result.amount * 100) / 100, source: "background",
            },
            ts: Timestamp.now(),
          });

          sellCount++;
          keepChecking = true; // เช็ครอบถัดไปต่อ เผื่อมีหลายรอบที่เข้าเงื่อนไขพร้อมกัน
        });
      } catch (err) {
        console.error(`[auto:${market}] sell check failed for user ${uid}:`, err.message);
        keepChecking = false;
      }
    }

    // 2) เช็คซื้อ (มีคูลดาวน์ 1 ชม./ครั้ง กันซื้อรัวตอนราคานิ่งต่ำกว่าเป้าหลายรอบติด)
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const fresh = snap.data();
        const freshLedger = fresh[ledgerKey];
        const freshAuto = freshLedger && freshLedger.autoTrade;
        if (!freshAuto || !freshAuto.enabled) return;
        if (now - (freshAuto.lastBuyAt || 0) < AUTO_TRADE_BUY_COOLDOWN_MS) return;
        if (signal.overbought) return; // RSI สูงเกินไป ข้ามรอบซื้อนี้เพื่อความปลอดภัย

        const lastSell = freshLedger.lastSell;
        const forecastFloor = signal.forecast.p10;
        const possibleDropPct = Math.max(0, (price - forecastFloor) / price * 100);
        const limitedDownside = possibleDropPct < PROFIT_TARGET * 100;
        const mechanicalTarget = lastSell ? lastSell.price / (1 + PROFIT_TARGET) : null;
        let targetPrice;
        if (limitedDownside) targetPrice = Math.min(price, forecastFloor);
        else if (mechanicalTarget != null) targetPrice = mechanicalTarget;
        else targetPrice = forecastFloor;
        if (price > targetPrice) return; // ยังไม่ถึงจุดซื้อ

        const buyAmount = lastSell ? lastSell.usd : freshAuto.buyAmount;
        if (!(buyAmount > 0)) return;

        const result = applyTrade(freshLedger, "buy", buyAmount, price, feeRate);
        const newAuto = { enabled: freshAuto.enabled, buyAmount: freshAuto.buyAmount, lastBuyAt: freshAuto.lastBuyAt || null };
        if (!result) {
          tx.update(userRef, { [`${ledgerKey}.autoTrade`]: newAuto });
          return;
        }
        newAuto.lastBuyAt = now;

        const equity = result.ledger.cash + result.ledger.btc * price;
        tx.update(userRef, {
          [`${ledgerKey}.cash`]: result.ledger.cash,
          [`${ledgerKey}.btc`]: result.ledger.btc,
          [`${ledgerKey}.avgEntry`]: result.ledger.avgEntry,
          [`${ledgerKey}.lots`]: result.ledger.lots,
          [`${ledgerKey}.autoTrade`]: newAuto,
        });

        const tradeRef = db.collection("trades").doc();
        tx.set(tradeRef, {
          uid, email: fresh.email || null, market, ccy: ledgerKey, side: "buy",
          price, qty: result.qty, usd: result.amount, fee: result.fee, equityAfter: equity,
          autoTrade: true, ts: Timestamp.now(),
        });

        const logRef = db.collection("logs").doc();
        tx.set(logRef, {
          uid, email: fresh.email || null, type: "auto_trade_triggered",
          detail: {
            market, side: "buy", reason: limitedDownside ? "forecast_floor" : (lastSell ? "edge_vs_last_sell" : "forecast_floor"),
            price: Math.round(price * 100) / 100, amount: Math.round(result.amount * 100) / 100, source: "background",
          },
          ts: Timestamp.now(),
        });

        buyCount++;
      });
    } catch (err) {
      console.error(`[auto:${market}] buy check failed for user ${uid}:`, err.message);
    }
  }
  console.log(`[auto:${market}] done, ${sellCount} sells, ${buyCount} buys executed`);
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

main().catch((err) => {
  console.error("check-orders failed:", err);
  process.exit(1);
});
