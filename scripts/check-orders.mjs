// รันโดย GitHub Actions ตามตารางเวลา (cron) — เช็คคำสั่งรอราคาของทุกผู้ใช้แล้วยิงคำสั่งซื้อ/ขายอัตโนมัติ
// ให้แม้ผู้ใช้จะไม่ได้เปิดหน้าเว็บค้างไว้ก็ตาม (ทำงานฝั่งเซิร์ฟเวอร์ผ่าน Firebase Admin SDK)
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { computeReturns, computeSignal } from "../shared/signals.mjs";
import { scoreMarket, describeScore, THRESHOLDS, computeATR } from "../shared/strategy.mjs";
import { evaluateIndicators, describeLearning } from "../shared/backtest.mjs";

const FEE_RATES = { binance: 0.001, bitkub: 0.0025 };
const LEDGER_KEY = { binance: "usd", bitkub: "thb" };
// (KLINE_LIMIT แท่ง 1 นาทีถูกลบไปแล้ว — ระบบใช้แท่ง 1 ชม.ล้วนตั้งแต่ scoreMarket ถึง spike detection)
// ---------- กลยุทธ์ "เล่นเฉพาะไม้ยาว" (spike fade) ----------
// ไม้เขียวยาว -> ขายบางส่วนรับรอบ แล้วตั้งซื้อคืนตอนราคาย่อกลับ
// ไม้แดงยาว  -> ซื้อบางส่วนตอนดิ่ง แล้วตั้งขายตอนราคาเด้งกลับ
// ไม้สั้น/ปกติ -> ไม่ทำอะไร (ไม่ไล่ซื้อระหว่างทาง)
const SPIKE_ATR_MULTIPLE = 1.5;  // ต้องยาวกว่าความผันผวนปกติของช่วงนั้น
// เทรดครั้งละกี่ % ของเหรียญในขา swing
// ทดสอบ 3 ปีแล้วพบว่า "เพิ่มขนาดต่อครั้ง" ได้ผลกว่า "เทรดถี่ขึ้น" ชัดเจน (ไม้ >=2.5% ย่อ 20%):
//   20% -> +0.78% | 40% -> +1.70% | 50% -> +2.17% | 60% -> +2.65% | 100% -> +4.64%
//   (กำไรทุกปีทั้งหมด ปิดรอบสำเร็จ 100% ทุกระดับ)
// ผลขึ้นเป็นเส้นตรงจนถึง 100% ไม่มีจุดพัง แต่ "ปิดรอบได้ 32/32 ครั้ง" มาจากตัวอย่างแค่ 32 ครั้ง
// ทางสถิติโอกาสพลาดจริงยังอาจสูงถึง ~8.9% ถ้าเจอสปайค์ที่ไม่ย่อกลับตอนใช้ 100% = เหรียญหายยกก้อน
// จึงเลือก 50% เป็นจุดสมดุล: ได้ผลตอบแทน ~2.8 เท่าของเดิม แต่ยังเหลือเหรียญอีกครึ่งไว้กันเหนียว
// SPIKE_RETRACE ไม่ได้ใช้ตั้งเป้าซื้อคืนแบบ retrace อีกต่อไป (ระบบ pool ใหม่ขายเมื่อกำไรจริงเท่านั้น
// ไม่ตั้งราคาเป้าล่วงหน้า) — เหลือไว้เพราะ spikeMinBodyPct ยังใช้ค่านี้เป็นตัวคูณสูตรเดิมที่ผ่าน backtest แล้ว
// เปลี่ยนค่านี้ = เกณฑ์ไม้ยาวเปลี่ยน ต้อง backtest ใหม่ทั้งหมด (ดู scripts/three-pool-vault-test.mjs)
const SPIKE_RETRACE = 0.20;
const SPIKE_FEE_SAFETY = 2.5;    // ส่วนต่างที่จะได้ ต้องมากกว่าค่าธรรมเนียมไป-กลับอย่างน้อยเท่านี้

// ---------- ระบบเทรดปัจจุบัน: "3 ก้อนคงที่ + กรุกำไรถาวร" ----------
// แทนที่ระบบเดิม (signal_buy ขนาดแปรผัน + forecast-target + ไม้เขียวยาวขาย 50% + คิวรอราคา) ทั้งหมด
// เพราะ backtest 9 ปี x 8 รอบพิสูจน์ว่าดีกว่าอย่างชัดเจนและเสถียร (+15.17% ถึง +15.63% เทียบถือยาว
// ทั้งจำนวนเหรียญและมูลค่าเงิน sd <1%) เทียบกับระบบเดิมที่ดีที่สุด (+14.57% แต่ผันผวนกว่า และแพ้ทันที
// ที่ปรับพารามิเตอร์เล็กน้อย) — ทดสอบเทียบมาแล้วกว่า 15 แนวทางอื่น (regime filter, volume filter,
// support/resistance, ensemble หลายกลยุทธ์, MACD/RSI filter, ไม่ใช้แท่งยาว ฯลฯ) ไม่มีตัวไหนชนะสูตรนี้เลย
//
// กติกา: แบ่งทุนเป็น 3 ก้อนเท่าๆ กัน (คงที่ตลอด ไม่โตไม่หด) แต่ละก้อนถือได้ทีละ 1 ไม้
//   ซื้อ: เจอไม้แดงยาว + คะแนนพอ + ก้อนนั้นว่างอยู่ -> ทุ่มเงินก้อนนั้นทั้งหมด
//   ขาย: เจอไม้เขียวยาว + ไม้ก้อนนั้นกำไรสุทธิแล้วเท่านั้น -> ขายทั้งไม้ (ถ้ายังไม่กำไร "ติดดอย" รอต่อ
//        ไม่มี stop-loss ไม่มี target ตายตัว — ข้อมูลพิสูจน์แล้วว่าดีกว่าไม่มีเพดานตัดขาดทุนเลย)
//   กำไรที่ขายได้จริง (proceeds - ต้นทุนไม้นั้น) แปลงเป็น BTC ทันที เก็บเข้า "กรุ" ถาวร ไม่เอากลับมาเทรดอีก
//   ต้นทุนกลับเข้าก้อนเดิมเสมอ ทำให้ทุนหมุนเวียนคงที่ตลอด ไม่ต้องเติมเงินใหม่ (ตามเป้าหมายที่ตั้งไว้)
const POOL_COUNT = 3;

// ขนาดไม้ขั้นต่ำ (% ของราคา) ที่ทำให้รอบนี้คุ้มค่าธรรมเนียมจริง
// กำไรต่อรอบ ~ retrace x body ต้องชนะค่าธรรมเนียมไป-กลับ (~2 x feeRate)
//   Binance (0.10%) -> ต้องยาว >= 2.50%
//   Bitkub  (0.25%) -> ต้องยาว >= 6.25%
//
// เคยลองแก้ให้ "ตลาดค่าธรรมเนียมแพงรอย่อลึกกว่า" (Bitkub 50%) เพื่อให้เกณฑ์ไม้เท่ากันที่ 2.5%
// แต่ทดสอบย้อนหลัง 3 ปีแล้วพบว่าแย่กว่ามาก: ย่อ 20% ปิดรอบได้เกือบ 100% (12/13, 12/13, 6/6)
// ส่วนย่อ 50% ปิดรอบแทบไม่ได้เลย (2/17, 0/12) = ขายเหรียญออกไปแล้วไม่ได้ซื้อคืน เหรียญหายถาวร
// ผลรวม 3 ปี: ย่อ 20% = +0.78% (ชนะ 3/3 ปี) | ย่อ 50% = -6.32% (ชนะ 0/3 ปี)
// จึงกลับมาตรึงที่ 20% แล้วยอมให้ Bitkub เข้าเทรดนานๆ ครั้งแทน (ซึ่งถูกต้องตามค่าธรรมเนียมที่แพงกว่า)
function spikeMinBodyPct(feeRate) {
  return (SPIKE_FEE_SAFETY * (2 * feeRate * 100)) / SPIKE_RETRACE;
}

// ไทม์เฟรมที่ใช้หา "ไม้ยาว" — ต้องเป็น 1 ชั่วโมงเท่านั้น ห้ามเปลี่ยนโดยไม่ทดสอบซ้ำ
// ทดสอบย้อนหลัง 3 ปีเทียบกันแล้ว: บนแท่ง 1 ชม. ได้ +0.78% ชนะ 3/3 ปี
// แต่บนแท่ง 15 นาที (ที่เคยใช้) ได้ -1.08% ชนะแค่ 2/3 ปี — ไม้สั้นกว่าทำให้สัญญาณเป็นความผันผวนมั่วๆ
// ดึงแท่ง 1 ชม. มาตรงๆ ไม่รวมเอาจากแท่ง 1 นาที เพราะ 900 แท่ง 1 นาที = แค่ 15 ชม. ไม่พอคำนวณ ATR(14)
const SPIKE_CANDLE_LIMIT = 200;

// ตรวจว่าแท่งล่าสุดเป็น "ไม้ยาว" ไหม — ต้องผ่านทั้ง 2 เงื่อนไข (ยาวกว่าปกติ + ยาวพอคุ้มค่าธรรมเนียม)
function detectSpike(candles, feeRate) {
  if (!candles || candles.length < 20) return null;
  const c = candles[candles.length - 1];
  if (!c || !c.o || !c.c) return null;
  const atr = computeATR(candles, 14);
  if (!atr) return null;
  const body = c.c - c.o;
  const bodyPct = Math.abs(body) / c.c * 100;
  const minBody = spikeMinBodyPct(feeRate);
  const longEnough = Math.abs(body) > SPIKE_ATR_MULTIPLE * atr;
  return {
    isSpike: longEnough && bodyPct >= minBody,
    direction: body > 0 ? "up" : "down",
    body, bodyPct, minBody, atr, longEnough,
    open: c.o, close: c.c,
  };
}

// core_dca (ซื้อสะสมทุก 12ชม., 5% ของทุนตั้งต้นต่อครั้ง, เพดาน 50% ของทุน) ถอดออกแล้วตามคำขอ
// ดูเหตุผลที่ processAutoTrade ตรงจุดที่เคยมีบล็อกนี้อยู่

function round2(n) { return Math.round(n * 100) / 100; }

// ส่ง Web Push แจ้งเตือนเมื่อมีการซื้อขายเกิดขึ้นจริง — อ่าน fcmTokens จาก users/{uid} แล้วส่งผ่าน Admin SDK
// เรียกนอก transaction เสมอ (side effect ภายนอกไม่ควรอยู่ใน retryable transaction ไม่งั้นอาจส่งซ้ำตอน retry)
// ผู้ใช้ที่ยังไม่เปิดแจ้งเตือน (ไม่มี fcmTokens) จะไม่มีอะไรเกิดขึ้น เงียบๆ ไม่ error
async function notifyTrade(db, messaging, uid, info) {
  if (!messaging) return;
  try {
    const snap = await db.collection("users").doc(uid).get();
    const tokens = (snap.data() || {}).fcmTokens || [];
    if (!tokens.length) return;

    const sideLabel = info.side === "buy" ? "ซื้อ" : "ขาย";
    const marketLabel = info.market === "bitkub" ? "Bitkub" : "Binance";
    const sym = info.ccy === "thb" ? "฿" : "$";
    const title = `${sideLabel} BTC — ${marketLabel}`;
    const body = `${sideLabel} ${info.qty.toFixed(8)} BTC ที่ ${sym}${Math.round(info.price).toLocaleString()} = ${sym}${Math.round(info.amount).toLocaleString()}${info.note ? " · " + info.note : ""}`;

    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: { url: "/", tag: "trade-" + info.market },
      webpush: { fcmOptions: { link: "https://coinplay.web.app/" } },
    });

    // เก็บกวาด token ที่ตายแล้ว (ผู้ใช้ถอนสิทธิ์/ล้างข้อมูลเบราว์เซอร์) กันสะสมค้างไปเรื่อยๆ
    const dead = [];
    res.responses.forEach((r, i) => {
      const code = r.error && r.error.code;
      if (!r.success && (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token")) {
        dead.push(tokens[i]);
      }
    });
    if (dead.length) {
      await db.collection("users").doc(uid).update({ fcmTokens: FieldValue.arrayRemove(...dead) });
    }
  } catch (err) {
    console.error(`notify failed for ${uid}:`, err.message);
  }
}

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

// แท่ง 1 ชม. เพียงชุดเดียว — ใช้ทั้งคำนวณคะแนนสัญญาณและหาไม้ยาว (ดูคอมเมนต์ที่ processAutoTrade)
async function fetchBinanceSpikeCandles() {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=${SPIKE_CANDLE_LIMIT}`);
    if (!res.ok) throw new Error("binance 1h klines http " + res.status);
    const data = await res.json();
    return data.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  } catch (err) {
    console.warn("binance 1h klines failed, falling back to Coinbase:", err.message);
    try {
      const res2 = await fetch("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600");
      if (!res2.ok) throw new Error("coinbase 1h http " + res2.status);
      const d = await res2.json();
      return d.map((k) => ({ t: k[0] * 1000, o: k[3], h: k[2], l: k[1], c: k[4], v: k[5] })).reverse();
    } catch (err2) {
      console.error("hourly candles unavailable this run:", err2.message);
      return null;
    }
  }
}

async function fetchBitkubSpikeCandles() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 3600 * SPIKE_CANDLE_LIMIT;
    const res = await fetch(`https://api.bitkub.com/tradingview/history?symbol=BTC_THB&resolution=60&from=${from}&to=${now}`);
    const data = await res.json();
    if (!data || !data.c || !data.t) return null;
    return data.t.map((t, i) => ({ t: t * 1000, o: data.o[i], h: data.h[i], l: data.l[i], c: data.c[i], v: data.v ? data.v[i] : null }));
  } catch (err) {
    console.warn("bitkub 1h klines failed:", err.message);
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

// ขาย "รอบที่ระบุ" เจาะจงตัวล็อตนั้นโดยตรง (ไม่ใช้ FIFO ทั่วไปแบบ applyTrade)
// ระบบออโต้เทรดปัจจุบัน (3-pool) ไม่ได้เรียกใช้ตัวนี้แล้ว (แต่ละ pool มีไม้เดียว รู้ตัวเองอยู่แล้วว่าไม้ไหน)
// เก็บไว้เพราะยัง export ให้ unit test เฉพาะจุดเรียกใช้อยู่ (scripts/_unit-test-*.mjs)
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

async function processMarket(db, messaging, market, price) {
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
      let notifyInfo = null;
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

          notifyInfo = { side: order.side, qty: result.qty, price, amount: result.amount, market, ccy: ledgerKey, note: "คำสั่งรอราคา" };
        });
        console.log(`[${market}] executed order ${order.id} (${order.side} @ ${order.targetPrice}) for user ${uid}`);
        if (notifyInfo) await notifyTrade(db, messaging, uid, notifyInfo);
      } catch (err) {
        console.error(`[${market}] failed to execute order ${order.id} for user ${uid}:`, err.message);
      }
    }
  }
}

// processDCA ถอดออกแล้ว — ออกแบบไว้สำหรับบัญชีที่เติมทุนใหม่เข้ามาเรื่อยๆ แต่บัญชีนี้ใช้ทุนก้อนเดียวคงที่
// (ดู main() ด้านล่าง) เหลือไว้แค่หมายเหตุนี้ ไม่มีฟังก์ชันแล้ว

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
// candles คือแท่ง 1 ชม. เพียงชุดเดียว — ใช้ทั้งคำนวณคะแนนสัญญาณ (RSI/EMA/MACD/ฯลฯ) และหาไม้ยาว
// เดิมคะแนนสัญญาณคำนวณจากแท่ง 1 นาทีแยกต่างหาก ขณะที่ไม้ยาวดูจากแท่ง 1 ชม. — คนละกรอบเวลากัน
// ทำให้ระบบ "กรองด้วยไม้ 1 ชม." แต่ "ตัดสินใจด้วยพฤติกรรมราคาในกรอบ 1 นาที" ซึ่งขัดกันเอง
// ตามที่กำหนดไว้ว่าจะเทรดเฉพาะไม้ 1 ชม. ขึ้นไป จึงรวมให้ใช้แท่ง 1 ชม. เป็นแหล่งเดียวทั้งหมด
// (ข้อดีเพิ่มเติม: ตรงกับที่ scripts/fulltest.mjs ใช้ทดสอบไว้พอดี เพราะตอนนั้นข้อมูล 1 นาทีย้อนหลัง
// 5 ปีดึงไม่ไหว จึงทดสอบด้วยแท่ง 1 ชม. ทั้งคู่อยู่แล้ว — ผลตัวเลข +13.36% จึงตรงกับของจริงมากขึ้น)
async function processAutoTrade(db, messaging, market, price, candles) {
  if (!price || !candles || candles.length < 100) {
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

  // กลยุทธ์เล่นเฉพาะไม้ยาว: ตรวจแท่งล่าสุดว่าเป็นไม้ยาวพอจะเข้าเทรดไหม
  const spike = detectSpike(candles, feeRate);

  console.log(`[auto:${market}] price=${price} score=${score.toFixed(1)} (${verdict}) atr%=${analysis.atrPct ? analysis.atrPct.toFixed(3) : "n/a"}`);
  if (spike) {
    console.log(`[auto:${market}] ไม้ล่าสุด ${spike.direction === "up" ? "เขียว" : "แดง"} ยาว ${spike.bodyPct.toFixed(3)}% (ต้องยาว >= ${spike.minBody.toFixed(2)}% และ > ${SPIKE_ATR_MULTIPLE}xATR) -> ${spike.isSpike ? "เข้าเงื่อนไขไม้ยาว" : "ไม้สั้นเกินไป ไม่เทรด"}`);
  }
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
    const minTicket = market === "bitkub" ? 100 : 5; // ขั้นต่ำจริงของตลาด (Binance ~$5, Bitkub ~฿100)
    const notifications = [];

    // ---------- ระบบ 3 ก้อนคงที่ ($100/฿1,000 ต่อก้อน) + กรุกำไรถาวร ----------
    // ดูเหตุผลและหลักฐาน backtest ที่คอมเมนต์ POOL_COUNT ด้านบนไฟล์ ทำทั้งขายและซื้อในทรานแซกชันเดียว
    // เพื่อให้สถานะก้อนสอดคล้องกันเสมอ (ขายก่อนแล้วเงินที่คืนก้อนอาจเอาไปซื้อไม้ใหม่ในรอบเดียวกันได้เลย)
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const fresh = snap.data();
        const fl = fresh[ledgerKey];
        const fa = fl && fl.autoTrade;
        if (!fa || !fa.enabled) return;

        // เริ่มก้อนครั้งแรก (หรือหลังรีเซ็ตบัญชี/เพิ่งเปลี่ยนมาระบบนี้): แบ่งเงินสดที่มีอยู่ตอนนี้เท่าๆ กัน
        // ถ้ามีไม้เดิมค้างอยู่ก่อนเปลี่ยนระบบ ใส่เข้าก้อนตามลำดับก่อน ที่เหลือค่อยแบ่งเงินสดเข้าก้อนที่ว่าง
        let pools = Array.isArray(fa.pools) && fa.pools.length === POOL_COUNT
          ? fa.pools.map((p) => ({ cash: p.cash || 0, lot: p.lot ? { ...p.lot } : null }))
          : null;
        if (!pools) {
          const existingLots = (fl.lots || []).filter((l) => l.qty > 0);
          pools = [];
          for (let i = 0; i < POOL_COUNT; i++) {
            pools.push(existingLots[i]
              ? { cash: 0, lot: { qty: existingLots[i].qty, price: existingLots[i].price, ts: existingLots[i].ts || now } }
              : { cash: 0, lot: null });
          }
          const emptyPools = pools.filter((p) => !p.lot);
          const perPool = emptyPools.length ? (fl.cash || 0) / emptyPools.length : 0;
          for (const p of emptyPools) p.cash = perPool;
        }
        let vaultBtc = fa.vaultBtc || 0;
        let vaultAvgPrice = fa.vaultAvgPrice || 0;

        // ---------- 1) ขาย: ไม้เขียวยาว -> ขายทุกก้อนที่ถือไม้และกำไรสุทธิเป็นบวกแล้ว ----------
        // ไม่มี stop-loss ไม่มี target ตายตัว — ก้อนที่ยังไม่กำไร ("ติดดอย") รอต่อจนกว่าจะกำไรแล้วค่อยขาย
        if (spike && spike.isSpike && spike.direction === "up") {
          for (let i = 0; i < pools.length; i++) {
            const pool = pools[i];
            if (!pool.lot) continue;
            const lotQty = pool.lot.qty, lotPrice = pool.lot.price;
            const netPnlPct = (price * (1 - feeRate) / (lotPrice * (1 + feeRate)) - 1) * 100;
            if (!(netPnlPct > 0)) continue;

            const proceeds = lotQty * price * (1 - feeRate);
            const cost = lotQty * lotPrice * (1 + feeRate);
            const fee = lotQty * price * feeRate;
            const profitUsd = Math.max(0, proceeds - cost);
            const profitBtc = profitUsd / price;

            const reasonText = `ไม้เขียวยาว: แท่งล่าสุดพุ่งขึ้น ${spike.bodyPct.toFixed(2)}% (ยาวกว่าปกติ ${(Math.abs(spike.body) / spike.atr).toFixed(1)} เท่าของ ATR ผ่านขั้นต่ำ ${spike.minBody.toFixed(2)}%) ก้อนที่ ${i + 1}/${POOL_COUNT} ซื้อไว้ที่ ${round2(lotPrice)} ตอนนี้ราคา ${round2(price)} กำไรสุทธิ +${netPnlPct.toFixed(2)}% จึงขายทั้งไม้ ${lotQty.toFixed(8)} BTC ได้เงิน ${round2(proceeds)} คืนทุน ${round2(cost)} เข้าก้อนเดิม ส่วนกำไร ${round2(profitUsd)} แปลงเป็น BTC ${profitBtc.toFixed(8)} เก็บเข้ากรุถาวร (ไม่เอากลับมาเทรดอีก)`;

            const tradeRef = db.collection("trades").doc();
            tx.set(tradeRef, {
              uid, email: fresh.email || null, market, ccy: ledgerKey, side: "sell",
              price, qty: lotQty, usd: proceeds, fee, equityAfter: null,
              autoTrade: true, sleeve: `pool${i}`, trigger: "pool_sell_profit", reason: reasonText, ts: Timestamp.now(),
            });
            await writeDecision(tx, uid, fresh.email, "sell", reasonText, {
              trigger: "pool_sell_profit", pool: i,
              lotBoughtAt: round2(lotPrice), btcSold: lotQty,
              proceeds: round2(proceeds), profitUsd: round2(profitUsd), profitBtc: round2(profitBtc),
            });

            vaultAvgPrice = vaultBtc + profitBtc > 0 ? (vaultAvgPrice * vaultBtc + price * profitBtc) / (vaultBtc + profitBtc) : price;
            vaultBtc += profitBtc;
            pool.cash += cost;
            pool.lot = null;
            sellCount++; didSomething = true;
            notifications.push({ side: "sell", qty: lotQty, price, amount: proceeds, market, ccy: ledgerKey, note: `ขายทำกำไรก้อนที่ ${i + 1}` });
          }
        }

        // ---------- 2) ซื้อ: ไม้แดงยาว + คะแนนพอ -> ทุ่มเงินทั้งก้อนในทุกก้อนที่ว่างอยู่ ----------
        const isBuySignal = spike && spike.isSpike && spike.direction === "down" && score >= THRESHOLDS.weakBuy;
        let anyBuy = false;
        const blockers = [];
        if (isBuySignal) {
          for (let i = 0; i < pools.length; i++) {
            const pool = pools[i];
            if (pool.lot) continue; // ก้อนนี้ไม่ว่าง ถือไม้อยู่แล้ว
            if (pool.cash < minTicket) continue; // เงินในก้อนนี้น้อยเกินขั้นต่ำตลาด

            const amount = pool.cash;
            const qty = (amount * (1 - feeRate)) / price;
            const fee = amount * feeRate;

            const reasonText = `ไม้แดงยาว: แท่งล่าสุดดิ่งลง ${spike.bodyPct.toFixed(2)}% (ยาวกว่าปกติ ${(Math.abs(spike.body) / spike.atr).toFixed(1)} เท่าของ ATR ผ่านขั้นต่ำ ${spike.minBody.toFixed(2)}% คะแนนรวม ${score.toFixed(1)} = ${verdict}) ก้อนที่ ${i + 1}/${POOL_COUNT} ว่างอยู่ จึงทุ่มเงินก้อนนี้ทั้งหมด ${round2(amount)} ซื้อที่ ${round2(price)} ได้ ${qty.toFixed(8)} BTC จะขายทั้งไม้เมื่อกำไรสุทธิเป็นบวกและเจอไม้เขียวยาวรอบถัดไป (ไม่มี stop-loss)`;

            const tradeRef = db.collection("trades").doc();
            tx.set(tradeRef, {
              uid, email: fresh.email || null, market, ccy: ledgerKey, side: "buy",
              price, qty, usd: amount, fee, equityAfter: null,
              autoTrade: true, sleeve: `pool${i}`, trigger: "pool_buy_spike", reason: reasonText, ts: Timestamp.now(),
            });
            await writeDecision(tx, uid, fresh.email, "buy", reasonText, {
              trigger: "pool_buy_spike", pool: i, btcBought: qty, amount: round2(amount),
            });

            pool.lot = { qty, price, ts: now };
            pool.cash = 0;
            buyCount++; didSomething = true; anyBuy = true;
            notifications.push({ side: "buy", qty, price, amount, market, ccy: ledgerKey, note: `เปิดไม้ก้อนที่ ${i + 1}` });
          }
          if (!anyBuy) {
            const fullPools = pools.filter((p) => p.lot).length;
            blockers.push(fullPools === POOL_COUNT
              ? `ถือครบทั้ง ${POOL_COUNT} ก้อนอยู่แล้ว รอขายก้อนใดก้อนหนึ่งก่อนถึงจะเปิดไม้ใหม่ได้`
              : `เงินสดในก้อนที่ว่างน้อยกว่าขั้นต่ำตลาด (${minTicket})`);
          }
        } else if (!spike || !spike.isSpike) {
          blockers.push(spike && spike.longEnough
            ? `แท่งล่าสุดยาว ${spike.bodyPct.toFixed(2)}% ยังไม่ถึงขั้นต่ำ ${spike.minBody.toFixed(2)}% ที่จะคุ้มค่าธรรมเนียม`
            : `แท่งล่าสุดเป็นไม้สั้น/ปกติ ไม่ใช่จังหวะเข้าตามกลยุทธ์ (เล่นเฉพาะไม้ยาว)`);
        } else if (spike.direction === "up") {
          blockers.push(`ไม้ล่าสุดเป็นไม้เขียวยาว (ราคาพุ่งขึ้น) ไม่ใช่จังหวะซื้อ — เป็นจังหวะขายรับรอบแทน`);
        } else if (score < THRESHOLDS.weakBuy) {
          blockers.push(`คะแนนรวม ${score.toFixed(1)} ยังต่ำกว่าเกณฑ์ซื้อ ${THRESHOLDS.weakBuy}`);
        }

        // ---------- รวมสถานะก้อนทั้งหมดกลับเป็น fl.cash / fl.btc / fl.lots / fl.avgEntry ให้ UI แสดงผลได้ ----------
        // กรุถาวรถูก tag เป็น sleeve:"core" (ตามธรรมเนียมเดิมของ UI ที่ไม่ขายอัตโนมัติ) แต่จริงๆ ไม่ถูกขายเลย
        const newCash = pools.reduce((s, p) => s + p.cash, 0);
        const poolLots = pools
          .map((p, i) => (p.lot ? { qty: p.lot.qty, price: p.lot.price, ts: p.lot.ts, sleeve: `pool${i}` } : null))
          .filter(Boolean);
        const newLots = vaultBtc > 1e-10
          ? poolLots.concat([{ qty: vaultBtc, price: vaultAvgPrice, ts: now, sleeve: "core" }])
          : poolLots;
        const newBtc = poolLots.reduce((s, l) => s + l.qty, 0) + vaultBtc;
        const costBasis = newLots.reduce((s, l) => s + l.qty * l.price, 0);
        const newAvgEntry = newBtc > 1e-10 ? costBasis / newBtc : 0;

        tx.update(userRef, {
          [`${ledgerKey}.cash`]: newCash,
          [`${ledgerKey}.btc`]: newBtc,
          [`${ledgerKey}.avgEntry`]: newAvgEntry,
          [`${ledgerKey}.lots`]: newLots,
          [`${ledgerKey}.autoTrade`]: Object.assign({}, fa, { pools, vaultBtc, vaultAvgPrice, lastCheckAt: now }),
        });

        if (blockers.length) {
          const topReasons = analysis.parts.slice().sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight)).slice(0, 3);
          const openPools = pools.filter((p) => p.lot).length;
          const holdReason = `${openPools > 0 ? `ถือ ${openPools}/${POOL_COUNT} ก้อนรอจังหวะ` : "ยังไม่เข้าเงื่อนไขซื้อ"}: ${blockers.join(" และ ")} — สรุปสภาพตลาดตอนนี้: ${verdict} (คะแนน ${score.toFixed(1)}) ปัจจัยที่มีน้ำหนักที่สุดคือ ${topReasons.map((r) => r.text).join(" | ")}`;
          await writeDecision(tx, uid, fresh.email, "hold", holdReason, { trigger: "no_action", blockers, poolsOpen: openPools, cash: round2(newCash) });
          holdCount++;
        }
      });
      for (const info of notifications) await notifyTrade(db, messaging, uid, info);
    } catch (err) {
      console.error(`[auto:${market}] pool trade failed for ${uid}:`, err.message);
    }
  }
  console.log(`[auto:${market}] done, ${sellCount} sells, ${buyCount} buys, ${holdCount} holds logged`);
}


async function main() {
  const app = initializeApp({ credential: cert(getServiceAccount()) });
  const db = getFirestore(app);
  const messaging = getMessaging(app);

  // processMarket (คำสั่งรอราคาที่ตั้งไว้) เช็คกับ price ตรงๆ ไม่ต้องใช้แท่งเทียน
  // จึงดึงแค่แท่ง 1 ชม. สำหรับ processAutoTrade เท่านั้น (ก่อนหน้านี้ยังดึงแท่ง 1 นาทีทิ้งไว้โดยไม่ได้ใช้)
  const [binancePrice, bitkubPrice, binanceHourly, bitkubHourly] = await Promise.all([
    fetchBinancePrice().catch((e) => { console.error("binance price fetch failed", e.message); return null; }),
    fetchBitkubPrice().catch((e) => { console.error("bitkub price fetch failed", e.message); return null; }),
    fetchBinanceSpikeCandles(),
    fetchBitkubSpikeCandles(),
  ]);

  await processMarket(db, messaging, "binance", binancePrice);
  await processMarket(db, messaging, "bitkub", bitkubPrice);
  // processDCA/core_dca ถอดออกแล้วตามคำขอ — ทั้งสองระบบออกแบบไว้สำหรับกรณีเติมทุนใหม่เข้ามาเรื่อยๆ
  // แต่บัญชีนี้ใช้ทุนก้อนเดียวคงที่ ไม่มีการเติมเงินเพิ่ม จึงไม่มีเหตุผลให้มีกลไกที่ล็อกทุนไว้ไม่หมุนแล้ว
  await processAutoTrade(db, messaging, "binance", binancePrice, binanceHourly);
  await processAutoTrade(db, messaging, "bitkub", bitkubPrice, bitkubHourly);

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
