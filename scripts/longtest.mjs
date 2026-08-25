// ทดสอบกลยุทธ์กับข้อมูลจริงย้อนหลัง 3 ปี — ทั้งฝั่งซื้อและฝั่งขาย
//
// Binance ให้ดึงได้ครั้งละ 1000 แท่ง จึงต้องวนดึงหลายรอบ (pagination) แล้วแคชลงดิสก์
// เพื่อไม่ต้องโหลดใหม่ทุกครั้งที่ทดสอบ
//
// รัน: node scripts/longtest.mjs [interval] [years]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { computeATR } from "../shared/strategy.mjs";

const FEE = { binance: 0.001, bitkub: 0.0025 };
const CACHE_DIR = "scripts/.cache";

async function fetchAll(interval, years) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const file = `${CACHE_DIR}/btc-${interval}-${years}y.json`;
  if (existsSync(file)) {
    const c = JSON.parse(readFileSync(file, "utf8"));
    console.log(`ใช้ข้อมูลที่แคชไว้: ${c.length} แท่ง`);
    return c;
  }
  const endTime = Date.now();
  const startTime = endTime - years * 365 * 86400e3;
  const out = [];
  let cursor = startTime;
  process.stdout.write("กำลังดึงข้อมูล");
  while (cursor < endTime) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${cursor}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("klines http " + res.status);
    const data = await res.json();
    if (!data.length) break;
    for (const k of data) out.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    cursor = data[data.length - 1][0] + 1;
    process.stdout.write(".");
    if (data.length < 1000) break;
  }
  console.log(` เสร็จ ${out.length} แท่ง`);
  writeFileSync(file, JSON.stringify(out));
  return out;
}

// คำนวณ ATR ล่วงหน้าทั้งชุดในรอบเดียว (Wilder) — เลี่ยงการ slice ซ้ำๆ ที่ทำให้ช้าแบบ O(n^2)
function atrSeries(candles, period = 14) {
  const tr = [0];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  let v = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = v;
  for (let i = period + 1; i < candles.length; i++) {
    v = (v * (period - 1) + tr[i]) / period;
    out[i] = v;
  }
  return out;
}

// กลยุทธ์เล่นเฉพาะไม้ยาว (ตรงกับที่ใช้จริงใน scripts/check-orders.mjs)
function runSpike(candles, atr, cfg) {
  const fee = cfg.fee;
  let cash = 0, btc = 0;
  const start = cfg.warmup;
  btc = (cfg.startCash / (1 + fee)) / candles[start].c; // เริ่มถือเหรียญเต็ม เทียบกับ buy&hold ได้ตรงๆ

  let pendBuy = null, pendSell = null;
  let sells = 0, buys = 0, rebuys = 0, resells = 0, spikeUp = 0, spikeDown = 0;
  let btcGained = 0;

  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const a = atr[i];
    if (!a) continue;

    // คำสั่งที่ตั้งค้างไว้ — ใช้ high/low เพราะราคาแตะระหว่างแท่งก็ถือว่าโดน
    if (pendBuy && c.l <= pendBuy.target) {
      const spend = Math.min(pendBuy.cash, cash);
      if (spend > cfg.minTicket) {
        const q = (spend / (1 + fee)) / pendBuy.target;
        btc += q; cash -= spend; rebuys++; buys++;
        btcGained += q - pendBuy.qtySold;
      }
      pendBuy = null;
    }
    if (pendSell && c.h >= pendSell.target) {
      const q = Math.min(pendSell.qty, btc);
      if (q * pendSell.target > cfg.minTicket) {
        cash += q * pendSell.target * (1 - fee); btc -= q; resells++; sells++;
      }
      pendSell = null;
    }

    const body = c.c - c.o;
    const bodyPct = Math.abs(body) / c.c * 100;
    if (!(Math.abs(body) > cfg.atrMult * a && bodyPct >= cfg.minBodyPct)) continue;

    if (body > 0) {
      spikeUp++;
      if (pendBuy) continue;                       // มีคำสั่งซื้อคืนค้างอยู่ ไม่ซ้อน
      const q = btc * cfg.tradePct;
      if (q * c.c > cfg.minTicket) {
        const proceeds = q * c.c * (1 - fee);
        cash += proceeds; btc -= q; sells++;
        pendBuy = { target: c.c - cfg.retrace * body, cash: proceeds, qtySold: q };
      }
    } else {
      spikeDown++;
      if (pendSell) continue;
      const spend = cash * cfg.tradePct;
      if (spend > cfg.minTicket) {
        const q = (spend / (1 + fee)) / c.c;
        btc += q; cash -= spend; buys++;
        pendSell = { target: c.c + cfg.retrace * Math.abs(body), qty: q };
      }
    }
  }
  const last = candles[candles.length - 1].c;
  return {
    cash, btc, sells, buys, rebuys, resells, spikeUp, spikeDown, btcGained,
    btcEq: (cash + btc * last) / last,
    btcHold: cfg.startCash / candles[start].c,
  };
}

const interval = process.argv[2] || "1h";
const years = parseFloat(process.argv[3] || "3");
const all = await fetchAll(interval, years);
const atr = atrSeries(all, 14);
const days = (all[all.length - 1].t - all[0].t) / 86400e3;
console.log(`BTCUSDT ${interval} ${all.length} แท่ง = ${(days / 365).toFixed(2)} ปี (${new Date(all[0].t).toISOString().slice(0,10)} ถึง ${new Date(all[all.length-1].t).toISOString().slice(0,10)})`);
console.log(`ราคา ${all[0].c.toFixed(0)} -> ${all[all.length-1].c.toFixed(0)} (${((all[all.length-1].c/all[0].c-1)*100).toFixed(1)}%)\n`);

const BASE = { startCash: 300, minTicket: 5, warmup: 60, tradePct: 0.2, atrMult: 1.5, fee: FEE.binance };
const V = (name, o) => Object.assign({ name }, BASE, o);
const VARIANTS = [
  V("ที่ใช้จริงตอนนี้: ไม้>=2.5% ย่อ 20%", { minBodyPct: 2.5, retrace: 0.2 }),
  V("ไม้>=1.5% ย่อ 20% (ผ่อนเกณฑ์)", { minBodyPct: 1.5, retrace: 0.2 }),
  V("ไม้>=1.0% ย่อ 50% (ไม้เล็กลง แต่รอย่อลึก)", { minBodyPct: 1.0, retrace: 0.5 }),
  V("ไม้>=2.5% ย่อ 50%", { minBodyPct: 2.5, retrace: 0.5 }),
  V("ไม้>=4% ย่อ 20% (เฉพาะไม้ใหญ่มาก)", { minBodyPct: 4, retrace: 0.2 }),
  V("ไม่กรองขนาด (สูตรดิบตามที่สั่ง)", { minBodyPct: 0, retrace: 0.2 }),
];

// แบ่งเป็นช่วงปี เพื่อดูว่าแต่ละสภาพตลาดผลต่างกันไหม
const YEAR = 365 * 86400e3;
const windows = [];
for (let s = all[0].t; s < all[all.length - 1].t; s += YEAR) {
  const w = all.filter((c) => c.t >= s && c.t < s + YEAR);
  if (w.length > 200) windows.push(w);
}

const totals = new Map(VARIANTS.map((v) => [v.name, []]));
windows.forEach((w, i) => {
  const wa = atrSeries(w, 14);
  const chg = (w[w.length - 1].c / w[60].c - 1) * 100;
  console.log(`--- ปีที่ ${i + 1} (${new Date(w[0].t).toISOString().slice(0,10)}) ราคา ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% ---`);
  for (const v of VARIANTS) {
    const r = runSpike(w, wa, v);
    const vs = (r.btcEq / r.btcHold - 1) * 100;
    totals.get(v.name).push(vs);
    console.log(`  ${v.name.padEnd(42)} ${vs >= 0 ? "+" : ""}${vs.toFixed(2).padStart(6)}% | ไม้ยาวขึ้น ${String(r.spikeUp).padStart(3)} ลง ${String(r.spikeDown).padStart(3)} | ขายรับรอบ ${String(r.sells).padStart(3)} ซื้อคืนสำเร็จ ${String(r.rebuys).padStart(3)} | เหรียญที่ได้เพิ่มจากรอบ ${r.btcGained >= 0 ? "+" : ""}${r.btcGained.toFixed(6)}`);
  }
  console.log("");
});

console.log("===== สรุป 3 ปี (เทียบกับซื้อทีเดียวแล้วถือเฉยๆ) =====");
[...totals.entries()].map(([name, arr]) => ({
  name, avg: arr.reduce((a, b) => a + b, 0) / arr.length,
  worst: Math.min(...arr), best: Math.max(...arr),
  wins: arr.filter((x) => x > 0).length, n: arr.length,
})).sort((a, b) => b.avg - a.avg).forEach((r) => {
  console.log(`  ${r.name.padEnd(42)} เฉลี่ย ${r.avg >= 0 ? "+" : ""}${r.avg.toFixed(2).padStart(6)}% | ดีสุด ${r.best >= 0 ? "+" : ""}${r.best.toFixed(2)}% แย่สุด ${r.worst.toFixed(2)}% | ชนะ ${r.wins}/${r.n} ปี`);
});
