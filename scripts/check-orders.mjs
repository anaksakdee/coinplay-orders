// รันโดย GitHub Actions ตามตารางเวลา (cron) — เช็คคำสั่งรอราคาของทุกผู้ใช้แล้วยิงคำสั่งซื้อ/ขายอัตโนมัติ
// ให้แม้ผู้ใช้จะไม่ได้เปิดหน้าเว็บค้างไว้ก็ตาม (ทำงานฝั่งเซิร์ฟเวอร์ผ่าน Firebase Admin SDK)
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

const FEE_RATES = { binance: 0.001, bitkub: 0.0025 };
const LEDGER_KEY = { binance: "usd", bitkub: "thb" };

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT env var");
  return JSON.parse(raw);
}

async function fetchBinancePrice() {
  const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
  const data = await res.json();
  return parseFloat(data.price);
}

async function fetchBitkubPrice() {
  // เซิร์ฟเวอร์เรียกตรงได้เลย ไม่ติด CORS เหมือนฝั่งเบราว์เซอร์
  const res = await fetch("https://api.bitkub.com/api/market/ticker");
  const data = await res.json();
  return data.THB_BTC ? data.THB_BTC.last : null;
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
          tx.update(userRef, {
            [`${ledgerKey}.cash`]: result.ledger.cash,
            [`${ledgerKey}.btc`]: result.ledger.btc,
            [`${ledgerKey}.avgEntry`]: result.ledger.avgEntry,
            [`${ledgerKey}.lots`]: result.ledger.lots,
            [`${ledgerKey}.orders`]: remainingOrders,
          });

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

async function main() {
  const app = initializeApp({ credential: cert(getServiceAccount()) });
  const db = getFirestore(app);

  const [binancePrice, bitkubPrice] = await Promise.all([
    fetchBinancePrice().catch((e) => { console.error("binance price fetch failed", e.message); return null; }),
    fetchBitkubPrice().catch((e) => { console.error("bitkub price fetch failed", e.message); return null; }),
  ]);

  await processMarket(db, "binance", binancePrice);
  await processMarket(db, "bitkub", bitkubPrice);

  console.log("done");
}

main().catch((err) => {
  console.error("check-orders failed:", err);
  process.exit(1);
});
