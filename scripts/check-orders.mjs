// รันโดย GitHub Actions ตามตารางเวลา (cron) — เช็คคำสั่งรอราคาของทุกผู้ใช้แล้วยิงคำสั่งซื้อ/ขายอัตโนมัติ
// ให้แม้ผู้ใช้จะไม่ได้เปิดหน้าเว็บค้างไว้ก็ตาม (ทำงานฝั่งเซิร์ฟเวอร์ผ่าน Firebase Admin SDK)
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { computeReturns, computeSignal } from "../shared/signals.mjs";
import { scoreMarket, describeScore, positionFraction, THRESHOLDS, computeATR } from "../shared/strategy.mjs";
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
const SPIKE_TRADE_PCT = 0.50;
const SPIKE_MAX_OPEN = 3;        // เปิดรอบซื้อคืนพร้อมกันได้สูงสุด 3 รอบ (ให้เงินสดหมุนต่อ)
// forecast-target sell เดิมใช้ fl.lastSell ช่องเดียวรอซื้อคืน — ทดสอบย้อนหลัง 9 ปีพบว่าตอนตลาดขาขึ้นแรง
// ต่อเนื่อง (เช่นปี 2020 +303%) เงินจะค้างรอราคาย่อที่ไม่มาถึง และบล็อกไม่ให้ซื้อไม้ใหม่ทั้งระบบ
// เปลี่ยนเป็นคิวหลายช่องเหมือนไม้เขียวยาว (orders[] ทำเครื่องหมาย forecast:true แยกโควตาต่างหาก)
// ผลทดสอบ 9 ปี x 8 รอบ: เทียบถือยาว -34.08% (ช่องเดียว) -> -16.51% (คิวหลายช่อง) ดีขึ้นทุกรอบ
const FORECAST_MAX_OPEN = 3;
const SPIKE_RETRACE = 0.20;      // ตั้งไม้สวนที่ 20% ของลำตัวไม้ — ตรึงไว้ ห้ามขยายให้ลึกกว่านี้ (ดูเหตุผลด้านล่าง)
const SPIKE_FEE_SAFETY = 2.5;    // ส่วนต่างที่จะได้ ต้องมากกว่าค่าธรรมเนียมไป-กลับอย่างน้อยเท่านี้

function spikeRetrace() { return SPIKE_RETRACE; }

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

// ขายเฉพาะเหรียญในขา swing เท่านั้น — ห้ามแตะขา core ที่ตั้งใจถือยาวไม่ขายออก
// จำเป็นเพราะ applyTrade ขายแบบ FIFO ไล่จากล็อตหน้าสุด ซึ่งอาจเป็นล็อต core
// (ยิ่งเพิ่ม % การเทรดต่อครั้ง ยิ่งกินขา core หนักขึ้น จนเจตนา "สะสมระยะยาว" พังทั้งหมด)
function sellSwingOnly(ledger, qtyWanted, price, feeRate) {
  const lots = (ledger.lots || []).map((l) => ({ ...l }));
  let remaining = qtyWanted;
  let sold = 0;
  const kept = [];
  for (const lot of lots) {
    if (lot.sleeve === "core" || remaining <= 1e-12) { kept.push(lot); continue; }
    if (lot.qty <= remaining) { remaining -= lot.qty; sold += lot.qty; }
    else { kept.push({ ...lot, qty: lot.qty - remaining }); sold += remaining; remaining = 0; }
  }
  if (sold <= 0) return null;
  const amount = sold * price;
  if (amount <= 0.01) return null;
  const fee = amount * feeRate;
  let btc = (ledger.btc || 0) - sold;
  if (btc < 1e-9) btc = 0;
  const cost = kept.reduce((a, l) => a + l.qty * l.price, 0);
  return {
    ledger: {
      cash: ledger.cash + amount - fee,
      btc, lots: kept,
      avgEntry: btc > 0 ? cost / btc : 0,
      orders: ledger.orders || [],
    },
    amount, fee, qty: sold,
  };
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

    // ---------- 1) ขา swing: ขายทำกำไร/ตัดขาดทุนแบบเก่า — ปิดถาวรแล้ว ----------
    // เคยมี 3 กลไก: (2% profit target), lock_profit_bearish, stop_loss — backtest ย้อนหลัง 5 ปีแบบ
    // ทั้งระบบรวมกันพบว่าทั้ง 3 ตัวทำลายพอร์ตด้วยรูปแบบเดียวกันเป๊ะ: ขายไม้ swing ถี่เกิน (60-76 ครั้ง/5ปี)
    // จนขา swing เหลือเหรียญศูนย์ ไปแย่งบทบาทกลยุทธ์ "ไม้ยาว" (ไม้เขียวยาวขายรับรอบ/ไม้แดงยาวเข้าซื้อ)
    // ที่มีคิวซื้อคืนของตัวเองอยู่แล้ว (สูงสุด 3 รอบ):
    //   2% profit target เปิดไว้:      -49.01% เทียบถือยาว
    //   lock_profit_bearish เปิดไว้:   -49.01% เทียบถือยาว (รูปแบบเดียวกันเป๊ะ ไม่เคยผ่าน backtest มาก่อน)
    //   stop_loss เปิดไว้:             -43.33% เฉลี่ย 8 รอบ (sd 1.6% เสถียร ไม่ใช่บังเอิญจาก Monte Carlo)
    //   ปิดทั้ง 3 ตัว เหลือแค่ไม้ยาว+core: +14.57% เฉลี่ย 8 รอบ (sd 1.8%) — ตรงกับที่เคยยืนยันไว้ก่อนหน้า
    // ผลคือบัญชีไม่มีเพดานตัดขาดทุนอีกต่อไป (แลกมาเพื่อให้กลยุทธ์ไม้ยาวทำงานได้เต็มที่ตามข้อมูลจริง)
    // ดู scripts/forecast-target-test.mjs สำหรับสคริปต์ backtest ที่ใช้ยืนยันตัวเลขข้างต้น

    // ---------- 1b) ไม้เขียวยาว: ขายรับรอบ 20% แล้วตั้งคำสั่งซื้อคืนตอนราคาย่อ ----------
    // ใช้ระบบ "คำสั่งรอราคา" (orders) ที่มีอยู่แล้ว ซึ่ง processMarket จะคอยเช็คให้ทุกรอบ
    if (spike && spike.isSpike && spike.direction === "up") {
      let notifyInfo = null;
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(userRef);
          const fresh = snap.data();
          const fl = fresh[ledgerKey];
          const fa = fl && fl.autoTrade;
          if (!fa || !fa.enabled) return;
          if (!(fl.btc > 0)) return;
          // ถ้ามีคำสั่งซื้อคืนจากไม้ยาวรอบก่อนค้างอยู่ ไม่ต้องซ้อนอีก
          // เปิดรอบพร้อมกันได้หลายรอบ เพื่อให้เงินสดหมุนต่อ ไม่ใช่จมรอรอบเดียวจบ
          // เดิมจำกัดไว้ 1 รอบ ทำให้สปайค์ถัดไปถูกข้ามทั้งหมดระหว่างรอซื้อคืน (เคยรอนานถึง 64 วัน)
          // ทดสอบ 5 ปี: 1 รอบ -> ปิดได้ 32 รอบ เหรียญเพิ่ม +9.16%
          //             3 รอบ -> ปิดได้ 86 รอบ เหรียญเพิ่ม +14.95%  <- เลือกอันนี้
          //             5 รอบ -> ปิดได้ 89 รอบ เหรียญเพิ่ม +15.02% (เพิ่มขึ้นน้อยมาก ไม่คุ้มความซับซ้อน)
          const openSpikes = (fl.orders || []).filter((o) => o.spike).length;
          if (openSpikes >= SPIKE_MAX_OPEN) return;

          // คิด % จากเหรียญในขา swing เท่านั้น ไม่นับขา core ที่ตั้งใจถือยาว
          const swingBtc = (fl.lots || []).filter((l) => l.sleeve !== "core").reduce((a, l) => a + l.qty, 0);
          if (!(swingBtc > 0)) return;
          const qty = swingBtc * SPIKE_TRADE_PCT;
          const amount = qty * price;
          const minTicket = market === "bitkub" ? 100 : 5;
          if (amount < minTicket) return;

          const result = sellSwingOnly(fl, qty, price, feeRate);
          if (!result) return;

          // ตั้งซื้อคืนที่ราคาย่อลงมา 20% ของลำตัวไม้ ใช้เงินที่เพิ่งขายได้ทั้งก้อน
          const retrace = spikeRetrace();
          const target = round2(price - retrace * Math.abs(spike.body));
          const expectedGainPct = ((price * (1 - feeRate)) / (target * (1 + feeRate)) - 1) * 100;
          const order = {
            id: "spk" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            // ใช้ "เงินที่ได้จากการขายรอบนี้" พอดีเป๊ะ ไม่ไปดึงเงินสดก้อนอื่นมาเสริม
            // เงินสดที่ได้จริง = result.amount*(1-fee) และตอนซื้อต้องกันค่าธรรมเนียมอีก (1+fee)
            // จึงต้องหารด้วย (1+fee) ไม่งั้นจะใช้เงินเกินไปประมาณ 0.1% ของก้อนทุกรอบ
            side: "buy", targetPrice: target,
            amount: round2((result.amount * (1 - feeRate)) / (1 + feeRate)),
            createdAt: now, spike: true,
          };
          const equity = result.ledger.cash + result.ledger.btc * price;

          tx.update(userRef, {
            [`${ledgerKey}.cash`]: result.ledger.cash,
            [`${ledgerKey}.btc`]: result.ledger.btc,
            [`${ledgerKey}.avgEntry`]: result.ledger.avgEntry,
            [`${ledgerKey}.lots`]: result.ledger.lots,
            [`${ledgerKey}.orders`]: (fl.orders || []).concat([order]),
          });

          const reasonText = `ไม้เขียวยาว: แท่งล่าสุดพุ่งขึ้น ${spike.bodyPct.toFixed(2)}% (ยาวกว่าปกติ ${(Math.abs(spike.body) / spike.atr).toFixed(1)} เท่าของ ATR และผ่านขั้นต่ำ ${spike.minBody.toFixed(2)}% ที่คุ้มค่าธรรมเนียม) จึงขายรับรอบ ${(SPIKE_TRADE_PCT * 100).toFixed(0)}% ของเหรียญที่ถือ = ${result.qty.toFixed(8)} BTC ที่ราคา ${round2(price)} แล้วตั้งซื้อคืนอัตโนมัติไว้ที่ ${target} (ย่อลง ${(retrace * 100).toFixed(0)}% ของลำตัวไม้) ถ้าราคาย่อถึงจะได้เหรียญกลับมามากกว่าเดิมประมาณ ${expectedGainPct.toFixed(2)}%`;

          const tradeRef = db.collection("trades").doc();
          tx.set(tradeRef, {
            uid, email: fresh.email || null, market, ccy: ledgerKey, side: "sell",
            price, qty: result.qty, usd: result.amount, fee: result.fee, equityAfter: equity,
            autoTrade: true, sleeve: "swing", trigger: "spike_up_fade", reason: reasonText, ts: Timestamp.now(),
          });
          await writeDecision(tx, uid, fresh.email, "sell", reasonText, {
            trigger: "spike_up_fade", sleeve: "swing",
            bodyPct: round2(spike.bodyPct), minBodyPct: round2(spike.minBody),
            btcSold: result.qty, rebuyTarget: target,
            expectedBtcGainPct: round2(expectedGainPct),
          });
          sellCount++;
          notifyInfo = { side: "sell", qty: result.qty, price, amount: result.amount, market, ccy: ledgerKey, note: "ไม้เขียวยาว ขายรับรอบ" };
        });
        if (notifyInfo) await notifyTrade(db, messaging, uid, notifyInfo);
      } catch (err) {
        console.error(`[auto:${market}] spike sell failed for ${uid}:`, err.message);
      }
    }

    // ---------- 1c) forecast target: ไม้ swing ถึงราคาเป้าหมายจาก Monte Carlo แล้วขายทั้งไม้ ----------
    // เพิ่มจากกลยุทธ์ไม้ยาวเดิม (ไม่แทนที่) — เป้าหมาย = p90 ของ Monte Carlo forecast (20 แท่งข้างหน้า)
    // ตั้งครั้งแรกตอนเจอไม้ แล้ว "รี้ดขึ้นอย่างเดียว" ทุกรอบตาม forecast ล่าสุด ไม่มีวันลดลง (เก็บไว้ที่ l.fcTarget)
    // ขายก็ต่อเมื่อราคาปัจจุบันถึงเป้าและมีกำไรสุทธิจริง (กันขายขาดทุนตอน forecast มองลบ)
    // backtest 5 ปี x 8 รอบเฉลี่ย: ช่วยให้ได้เหรียญจากการหมุนรอบเพิ่มขึ้นเมื่อรวมกับกลยุทธ์ไม้ยาวที่ผ่านแล้ว
    {
      const forecast = analysis.signal && analysis.signal.forecast;
      let keepChecking2 = !!(forecast && forecast.p90 > 0), guard2 = 0;
      while (keepChecking2 && guard2 < 30) {
        keepChecking2 = false; guard2++;
        let notifyInfo = null;
        try {
          await db.runTransaction(async (tx) => {
            const snap = await tx.get(userRef);
            const fresh = snap.data();
            const fl = fresh[ledgerKey];
            const fa = fl && fl.autoTrade;
            if (!fa || !fa.enabled || !fl.lots || !fl.lots.length) return;

            const openForecast = (fl.orders || []).filter((o) => o.forecast).length;

            const lots = fl.lots.map((l) => ({ ...l }));
            let lot = null;
            for (const l of lots) {
              if (l.sleeve === "core") continue;
              l.fcTarget = Math.max(l.fcTarget || 0, forecast.p90);
              const netPnlPct = (price * (1 - feeRate) / (l.price * (1 + feeRate)) - 1) * 100;
              if (price >= l.fcTarget && netPnlPct > 0 && openForecast < FORECAST_MAX_OPEN) { lot = l; break; }
            }
            // เขียนเป้าหมายที่รี้ดขึ้นกลับไปเสมอ แม้ยังไม่ถึงเป้า จะได้รี้ดต่อจากค่านี้ในรอบหน้า
            tx.update(userRef, { [`${ledgerKey}.lots`]: lots });
            if (!lot) return;

            const result = sellSpecificLot(fl, lot, price, feeRate);
            if (!result) return;
            const equity = result.ledger.cash + result.ledger.btc * price;
            // ตั้งคำสั่งซื้อคืนแบบคิวหลายช่อง (เหมือนไม้เขียวยาว) แทน fl.lastSell ช่องเดียว — กันบล็อกทั้งระบบ
            // ตอนตลาดขาขึ้นแรงต่อเนื่องแล้วราคาไม่ย่อกลับมาถึงเพดานซื้อคืน (ดู FORECAST_MAX_OPEN ด้านบน)
            const rebuyTarget = round2(btcAccumCeiling(price, feeRate, BTC_ACCUM_TARGET));
            const rebuyOrder = {
              id: "fct" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              side: "buy", targetPrice: rebuyTarget,
              amount: round2((result.amount * (1 - feeRate)) / (1 + feeRate)),
              createdAt: now, forecast: true,
            };
            const reasonText = `ถึงราคาเป้าหมายจาก Monte Carlo: ไม้นี้ซื้อที่ ${round2(lot.price)} ตอนนี้ราคา ${round2(price)} ถึงเป้าหมายที่คาดการณ์ไว้ ${round2(lot.fcTarget)} แล้ว (กำไรสุทธิ +${((price * (1 - feeRate) / (lot.price * (1 + feeRate)) - 1) * 100).toFixed(2)}%) จึงขายทำกำไรทั้งไม้ แล้วตั้งซื้อคืนอัตโนมัติไว้ที่ ${rebuyTarget}`;

            tx.update(userRef, {
              [`${ledgerKey}.cash`]: result.ledger.cash,
              [`${ledgerKey}.btc`]: result.ledger.btc,
              [`${ledgerKey}.avgEntry`]: result.ledger.avgEntry,
              [`${ledgerKey}.lots`]: result.ledger.lots,
              [`${ledgerKey}.orders`]: (fl.orders || []).concat([rebuyOrder]),
            });

            const tradeRef = db.collection("trades").doc();
            tx.set(tradeRef, {
              uid, email: fresh.email || null, market, ccy: ledgerKey, side: "sell",
              price, qty: result.qty, usd: result.amount, fee: result.fee, equityAfter: equity,
              autoTrade: true, sleeve: "swing", trigger: "forecast_target", reason: reasonText, ts: Timestamp.now(),
            });
            await writeDecision(tx, uid, fresh.email, "sell", reasonText, {
              trigger: "forecast_target",
              lotBoughtAt: round2(lot.price),
              forecastTarget: round2(lot.fcTarget),
              btcSold: result.qty,
              proceeds: round2(result.amount),
            });

            sellCount++; didSomething = true;
            keepChecking2 = true;
            notifyInfo = { side: "sell", qty: result.qty, price, amount: result.amount, market, ccy: ledgerKey, note: "ถึงราคาเป้าหมาย (forecast)" };
          });
          if (notifyInfo) await notifyTrade(db, messaging, uid, notifyInfo);
        } catch (err) {
          console.error(`[auto:${market}] forecast target sell failed for ${uid}:`, err.message);
          keepChecking2 = false;
        }
      }
    }

    // ---------- 2) พิจารณาซื้อ (ทั้งขา swing และขา core) ----------
    let notifyInfo = null;
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const fresh = snap.data();
        const fl = fresh[ledgerKey];
        const fa = fl && fl.autoTrade;
        if (!fa || !fa.enabled) return;

        const cash = fl.cash || 0;
        const minTicket = market === "bitkub" ? 100 : 5; // ขั้นต่ำจริงของตลาด (Binance ~$5, Bitkub ~฿100) ไม้เล็กกว่านี้สั่งจริงไม่ผ่าน
        const blockers = [];

        // core_dca (ซื้อสะสมทุก 12ชม. ไม่สนราคา) ถอดออกแล้วตามคำขอ — ออกแบบไว้สำหรับบัญชีที่เติมทุนใหม่
        // เข้ามาเรื่อยๆ แต่บัญชีนี้ใช้ทุนก้อนเดียวคงที่ ไม่มีการเติมเงินเพิ่ม จึงไม่ล็อกทุนไว้ในขาที่ไม่ขายอีกต่อไป
        // ไม้ core เดิมที่เคยซื้อไว้ก่อนหน้านี้ยังคงอยู่และไม่ถูกขายอัตโนมัติเหมือนเดิม (ดู sleeve==="core" filter)
        // เหลือแค่ signal_buy (ไม้แดงยาว) เป็นกลไกเดียวที่นำทุนใหม่เข้าสู่ตลาด

        // พิจารณาเปิดไม้ใหม่ตามคะแนนสัญญาณ (ไม้แดงยาว)
        if (cash < minTicket) {
          await writeDecision(tx, uid, fresh.email, "hold",
            `ไม่ซื้อ: เงินสดคงเหลือ ${round2(cash)} น้อยเกินกว่าจะเปิดไม้ใหม่ได้ (ขั้นต่ำ ${minTicket}) — เงินถูกแปลงเป็น BTC ไปเกือบหมดแล้ว ระบบจะรอจังหวะขายทำกำไรเพื่อให้มีเงินสดกลับมาหมุนต่อ`,
            { trigger: "no_cash", cash: round2(cash) });
          holdCount++;
          return;
        }

        // ขา swing: เข้าเทรด "เฉพาะไม้ยาว" เท่านั้น ไม่ไล่ซื้อไม้สั้นระหว่างทาง
        // ไม้แดงยาว = จังหวะเข้าซื้อ (ราคาดิ่งแรงเกินจริง มีโอกาสเด้ง) แล้วตั้งขายตอนเด้งกลับ
        // ไม้เขียวยาวจะไปเข้าเงื่อนไข "ขายรับรอบ" ด้านบนแทน ไม่ใช่จุดซื้อ
        if (!spike || !spike.isSpike) {
          blockers.push(spike && spike.longEnough
            ? `แท่งล่าสุดยาว ${spike.bodyPct.toFixed(2)}% ยังไม่ถึงขั้นต่ำ ${spike.minBody.toFixed(2)}% ที่จะคุ้มค่าธรรมเนียม`
            : `แท่งล่าสุดเป็นไม้สั้น/ปกติ ไม่ใช่จังหวะเข้าตามกลยุทธ์ (เล่นเฉพาะไม้ยาว)`);
        } else if (spike.direction === "up") {
          blockers.push(`ไม้ล่าสุดเป็นไม้เขียวยาว (ราคาพุ่งขึ้น) ไม่ใช่จังหวะซื้อ — เป็นจังหวะขายรับรอบแทน`);
        }
        if (score < THRESHOLDS.weakBuy) blockers.push(`คะแนนรวม ${score.toFixed(1)} ยังต่ำกว่าเกณฑ์ซื้อ ${THRESHOLDS.weakBuy}`);

        // ไม่จำกัดว่าห้ามซื้อที่ราคาใกล้ไม้เดิม — ซื้อกองที่ราคาเดียวกันไม่ผิด ถ้าสัญญาณบอกว่าควรซื้อ
        // ตัวตัดสินคือ "คุณภาพสัญญาณ" อย่างเดียว (คะแนนรวมจากอินดิเคเตอร์ที่ถ่วงน้ำหนักตามความแม่นจริง)

        if (blockers.length) {
          const topReasons = analysis.parts.slice().sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight)).slice(0, 3);
          await writeDecision(tx, uid, fresh.email, "hold",
            `ยังไม่เข้าเงื่อนไขซื้อ: ${blockers.join(" และ ")} — สรุปสภาพตลาดตอนนี้: ${verdict} (คะแนน ${score.toFixed(1)}) ปัจจัยที่มีน้ำหนักที่สุดคือ ${topReasons.map((r) => r.text).join(" | ")}`,
            { trigger: "below_threshold", blockers, cash: round2(cash) });
          holdCount++;
          return;
        }

        const frac = positionFraction(score, analysis.atrPct, fa.minBuyFrac, fa.maxBuyFrac);
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
        const swingReason = `เปิดไม้เทรดสั้น (swing): คะแนนรวม ${score.toFixed(1)} = ${verdict} ผ่านเกณฑ์ซื้อ ${THRESHOLDS.weakBuy} จึงลงเงิน ${round2(result.amount)} (${(frac * 100).toFixed(0)}% ของเงินสด ปรับขนาดตามความมั่นใจและความผันผวน ATR ${analysis.atrPct ? analysis.atrPct.toFixed(2) + "%" : "n/a"}) ได้ ${result.qty.toFixed(8)} BTC — เหตุผลหลักที่เข้าซื้อ: ${topReasons.map((r) => r.text).join(" | ")} — ไม้นี้จะถูกขายรับรอบเมื่อเจอไม้เขียวยาว (ไม่ได้ตั้งขายที่ราคาตายตัว)`;
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
        notifyInfo = { side: "buy", qty: result.qty, price, amount: result.amount, market, ccy: ledgerKey, note: "เปิดไม้ใหม่ตามสัญญาณ" };
      });
      if (notifyInfo) await notifyTrade(db, messaging, uid, notifyInfo);
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
                        await db.collection("logs").add({
              uid, email: data.email || null, type: "auto_decision",
              detail: {
                market, action: "hold", source: "background", trigger: "holding_position",
                reason: `ถือไม้รอจังหวะ: มีไม้เทรดสั้นค้างอยู่ ${swingLots.length} ไม้ ระบบจะขายรับรอบก็ต่อเมื่อเจอไม้เขียวยาว (>=2.5% บนกราฟ 1 ชม.) หรือเข้าเงื่อนไขตัดขาดทุน ตอนนี้ราคา ${round2(price)} คะแนนรวม ${score.toFixed(1)} (${verdict}) ยังไม่เข้าเงื่อนไขขาย`,
                market_analysis: marketSnapshot,
                openSwingLots: swingLots.length,
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
