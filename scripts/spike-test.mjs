// ทดสอบกลยุทธ์ "เล่นเฉพาะไม้ยาว" (spike fade) ตามที่ผู้ใช้ออกแบบ
//
//   ไม้เขียวยาว (พุ่งขึ้นแรง)  -> ขาย X% ของเหรียญที่ถือ แล้วตั้งซื้อคืนเมื่อราคาย่อลงมา R% ของช่วงไม้นั้น
//   ไม้แดงยาว  (ดิ่งลงแรง)   -> ซื้อด้วย X% ของเงินสด แล้วตั้งขายเมื่อราคาเด้งกลับขึ้นไป R% ของช่วงไม้นั้น
//   ไม้สั้น/ปกติ -> ไม่ทำอะไรเลย
//
// "ไม้ยาว" นิยามด้วยขนาดลำตัวเทียบกับ ATR (ความผันผวนปกติของช่วงนั้น) เพื่อให้ปรับตัวตามสภาพตลาด
// ไม่ใช่ตัวเลข % ตายตัวที่จะแปลความหมายเพี้ยนเมื่อความผันผวนเปลี่ยน
import { fetchCandles } from "./simulate.mjs";
import { computeATR } from "../shared/strategy.mjs";

const FEE = 0.001;
const WARMUP = 60;

export function runSpike(candles, cfg) {
  let cash = cfg.startCash;
  let btc = 0;
  // เริ่มด้วยการถือเหรียญบางส่วน ไม่งั้นไม้เขียวยาวแรกๆ จะไม่มีของให้ขาย
  const seedSpend = cfg.startCash * cfg.seedPct;
  btc = (seedSpend / (1 + FEE)) / candles[WARMUP].c;
  cash -= seedSpend;

  let pendingBuy = null;   // { target, cashReserved }
  let pendingSell = null;  // { target, qty }
  let spikesUp = 0, spikesDown = 0, buys = 0, sells = 0, rebuys = 0, resells = 0;

  for (let i = WARMUP; i < candles.length; i++) {
    const c = candles[i];
    const price = c.c;
    const atr = computeATR(candles.slice(0, i + 1), 14);
    if (!atr || !isFinite(price)) continue;

    // ---- คำสั่งที่ตั้งค้างไว้: เช็คด้วย low/high ของแท่ง เพราะราคาแตะระหว่างแท่งก็ถือว่าโดน ----
    if (pendingBuy && c.l <= pendingBuy.target) {
      const spend = Math.min(pendingBuy.cashReserved, cash);
      if (spend > cfg.minTicket) {
        const amt = spend / (1 + FEE);
        btc += amt / pendingBuy.target;
        cash -= spend;
        rebuys++; buys++;
      }
      pendingBuy = null;
    }
    if (pendingSell && c.h >= pendingSell.target) {
      const qty = Math.min(pendingSell.qty, btc);
      if (qty * pendingSell.target > cfg.minTicket) {
        cash += qty * pendingSell.target * (1 - FEE);
        btc -= qty;
        resells++; sells++;
      }
      pendingSell = null;
    }

    // ---- ตรวจ "ไม้ยาว" ----
    const body = c.c - c.o;
    const bodyPct = Math.abs(body) / price * 100;
    // เงื่อนไข 2 ชั้น:
    //  1) ยาวกว่าปกติของช่วงนั้น (เทียบ ATR) — ปรับตัวตามความผันผวน
    //  2) ยาวพอในเชิงสัมบูรณ์ จนส่วนต่างที่จะได้ (retrace x body) ชนะค่าธรรมเนียมไป-กลับจริงๆ
    //     ถ้าไม่มีข้อ 2 ไม้ 1% ย่อ 20% จะได้ 0.000% พอดี = เหนื่อยฟรี เสียค่าธรรมเนียมเปล่า
    const isLong = Math.abs(body) > cfg.atrMultiple * atr && bodyPct >= cfg.minBodyPct;
    if (!isLong) continue;

    if (body > 0) {
      // ไม้เขียวยาว: ขายบางส่วนรับรอบ แล้วรอซื้อคืนตอนย่อ
      spikesUp++;
      const qty = btc * cfg.tradePct;
      if (qty * price > cfg.minTicket) {
        const proceeds = qty * price * (1 - FEE);
        cash += proceeds; btc -= qty; sells++;
        pendingBuy = { target: price - cfg.retrace * body, cashReserved: proceeds };
      }
    } else {
      // ไม้แดงยาว: ซื้อบางส่วนตอนดิ่ง แล้วรอขายตอนเด้ง
      spikesDown++;
      const spend = cash * cfg.tradePct;
      if (spend > cfg.minTicket) {
        const amt = spend / (1 + FEE);
        const qty = amt / price;
        btc += qty; cash -= spend; buys++;
        pendingSell = { target: price + cfg.retrace * Math.abs(body), qty };
      }
    }
  }

  const last = candles[candles.length - 1].c;
  return {
    cash, btc, spikesUp, spikesDown, buys, sells, rebuys, resells,
    btcEquivalent: (cash + btc * last) / last,
    btcIfHeld: cfg.startCash / candles[WARMUP].c,
  };
}

const BASE = { startCash: 300, minTicket: 5, seedPct: 1.0, tradePct: 0.2, retrace: 0.2, atrMultiple: 1.5, minBodyPct: 0 };
const cfg = (name, o) => Object.assign({ name }, BASE, o);

const VARIANTS = [
  cfg("ตามที่สั่งเดิม: ย่อ 20% ไม่มีขั้นต่ำ", {}),
  cfg("ย่อ 20% + ไม้ต้องยาว >=3%", { minBodyPct: 3 }),
  cfg("ย่อ 50% + ไม้ต้องยาว >=1.2%", { retrace: 0.5, minBodyPct: 1.2 }),
  cfg("ย่อ 50% + ไม้ต้องยาว >=2%", { retrace: 0.5, minBodyPct: 2 }),
  cfg("ย่อ 40% + ไม้ยาว >=1.5%, เทรด 30%", { retrace: 0.4, minBodyPct: 1.5, tradePct: 0.3 }),
];

const interval = process.argv[2] || "1h";
const all = await fetchCandles(interval, 1000);
const CHUNK = 340;
const windows = [];
for (let s = 0; s + CHUNK <= all.length; s += 220) windows.push(all.slice(s, s + CHUNK));

console.log(`ข้อมูลจริง BTCUSDT ${interval} ${all.length} แท่ง (~${((all[all.length-1].t-all[0].t)/86400e3).toFixed(0)} วัน), ${windows.length} ช่วง\n`);
const totals = new Map(VARIANTS.map((v) => [v.name, []]));

windows.forEach((w, wi) => {
  const chg = (w[w.length - 1].c / w[WARMUP].c - 1) * 100;
  console.log(`--- ช่วง ${wi + 1}: ราคา ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% ---`);
  for (const v of VARIANTS) {
    const r = runSpike(w, v);
    const vsHold = (r.btcEquivalent / r.btcIfHeld - 1) * 100;
    totals.get(v.name).push(vsHold);
    console.log(`  ${v.name.padEnd(46)} ${vsHold >= 0 ? "+" : ""}${vsHold.toFixed(2).padStart(6)}% | ไม้ยาวขึ้น ${String(r.spikesUp).padStart(3)} ลง ${String(r.spikesDown).padStart(3)} | ซื้อคืนสำเร็จ ${r.rebuys} ขายเด้งสำเร็จ ${r.resells}`);
  }
  console.log("");
});

console.log("===== สรุป (เทียบซื้อทีเดียวแล้วถือเฉยๆ) =====");
[...totals.entries()].map(([name, arr]) => ({
  name, avg: arr.reduce((a, b) => a + b, 0) / arr.length,
  worst: Math.min(...arr), wins: arr.filter((x) => x > 0).length, n: arr.length,
})).sort((a, b) => b.avg - a.avg).forEach((r) => {
  console.log(`  ${r.name.padEnd(46)} เฉลี่ย ${r.avg >= 0 ? "+" : ""}${r.avg.toFixed(2).padStart(6)}% แย่สุด ${r.worst.toFixed(2).padStart(7)}% ชนะ ${r.wins}/${r.n}`);
});
