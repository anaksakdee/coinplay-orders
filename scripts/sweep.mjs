// ทดสอบกติกาบริหารเงินหลายๆ ชุด กับตลาดจริงหลายช่วง (ขาขึ้น/ขาลง/ออกข้าง)
// เพื่อไม่ให้สรุปจากช่วงเดียวแล้วเข้าใจผิด — ช่วงขาขึ้นจะเข้าข้างการถือเต็มพอร์ตเสมอ
import { fetchCandles, simulate } from "./simulate.mjs";
import { THRESHOLDS } from "../shared/strategy.mjs";

const BASE = {
  startCash: 300, minTicket: 10,
  buyThreshold: THRESHOLDS.weakBuy, maxOpenSwing: Infinity, minSeparationPct: 0,
  sizeOffEquity: false, maxPositionPct: 0.6, cashFloorPct: 0,
  coreIntervalMs: 12 * 3600e3, coreFractionOfStart: 0.10, coreMaxPct: Infinity,
  dynamicTarget: false, minProfit: 0.008, atrMultiple: 6,
};
const cfg = (name, o) => Object.assign({ name }, BASE, o);

// ทดสอบ "เกณฑ์คะแนนขั้นต่ำที่จะซื้อ" โดยเฉพาะ — ตัวนี้คือตัวคุมว่าระบบจะซื้อถี่แค่ไหน
// คะแนน 8 บนสเกล -100..100 แทบจะเป็นกลาง จึงซื้อได้เกือบตลอดเวลารวมถึงตอนกราฟกำลังขึ้น
const CONFIGS = [
  cfg("เกณฑ์ 8 (ของเดิม)", { buyThreshold: 8 }),
  cfg("เกณฑ์ 15", { buyThreshold: 15 }),
  cfg("เกณฑ์ 22", { buyThreshold: 22 }),
  cfg("เกณฑ์ 30", { buyThreshold: 30 }),
  cfg("เกณฑ์ 40", { buyThreshold: 40 }),
];

function regimeLabel(c) {
  const chg = (c[c.length - 1].c / c[120].c - 1) * 100;
  if (chg > 4) return `ขาขึ้น +${chg.toFixed(1)}%`;
  if (chg < -4) return `ขาลง ${chg.toFixed(1)}%`;
  return `ออกข้าง ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%`;
}

const all = await fetchCandles(process.argv[2] || "1h", 1000);
const CHUNK = 340; // ~14 วันต่อช่วง (มี warmup 120 อยู่ในนั้น)
const windows = [];
for (let s = 0; s + CHUNK <= all.length; s += 220) windows.push(all.slice(s, s + CHUNK));

console.log(`ข้อมูลจริง BTCUSDT 1h ${all.length} แท่ง (~${((all[all.length-1].t-all[0].t)/86400e3).toFixed(0)} วัน) แบ่งทดสอบ ${windows.length} ช่วง\n`);

const totals = new Map(CONFIGS.map((c) => [c.name, []]));

windows.forEach((w, wi) => {
  console.log(`--- ช่วงที่ ${wi + 1}: ${regimeLabel(w)} ---`);
  for (const c of CONFIGS) {
    const r = simulate(w, c);
    const vsHold = (r.btcEquivalent / r.btcIfHeld - 1) * 100;
    totals.get(c.name).push(vsHold);
    console.log(`  ${c.name.padEnd(38)} เทียบถือเฉยๆ ${vsHold >= 0 ? "+" : ""}${vsHold.toFixed(2).padStart(6)}%  | ซื้อ ${String(r.buys).padStart(3)} ขาย ${String(r.sells).padStart(3)} รอบครบวง ${r.roundTrips} | เงินสดต่ำสุด ${(r.minCashPct * 100).toFixed(0).padStart(3)}%`);
  }
  console.log("");
});

console.log("===== สรุปรวมทุกช่วง (เทียบกับการซื้อทีเดียวแล้วถือเฉยๆ) =====");
const rows = [...totals.entries()].map(([name, arr]) => {
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  const worst = Math.min(...arr);
  const wins = arr.filter((x) => x > 0).length;
  return { name, avg, worst, wins, n: arr.length };
}).sort((a, b) => b.avg - a.avg);
for (const r of rows) {
  console.log(`  ${r.name.padEnd(38)} เฉลี่ย ${r.avg >= 0 ? "+" : ""}${r.avg.toFixed(2).padStart(6)}%  แย่สุด ${r.worst.toFixed(2).padStart(7)}%  ชนะ ${r.wins}/${r.n} ช่วง`);
}
