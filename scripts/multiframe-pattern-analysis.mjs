// วิเคราะห์แพทเทิร์น "แท่งยาว" บนไทม์เฟรมใหญ่ขึ้น: 3 วัน / 1 สัปดาห์ / 1 เดือน / 3 เดือน / 6 เดือน
// ตลอด 9 ปีข้อมูลจริง — resample จากแท่ง 1 ชม. (พร้อม volume) ขึ้นเป็นแท่งใหญ่ แล้วใช้เกณฑ์หา "ไม้ยาว"
// แบบเดียวกับที่ระบบใช้จริงบนแท่ง 1 ชม. (>1.5xATR(14) ของไทม์เฟรมนั้น และ body% ยาวพอ) — ปรับสเกลตามธรรมชาติ
// เพราะ ATR คำนวณจากข้อมูลไทม์เฟรมนั้นเอง ไม่ได้เอาเกณฑ์ 1 ชม. มาใช้ตรงๆ
//
// รันเอง: node scripts/multiframe-pattern-analysis.mjs
import { readFileSync } from "fs";

const VOL_CACHE = "scripts/.cache/btc-1h-10y-vol.json";
const ATR_MULT = 1.5;
const MIN_BODY_PCT = 2.5; // ใช้เกณฑ์เดียวกับที่ระบบจริงใช้บน Binance (feeRate 0.001) เป็นมาตรฐานเทียบ

function atrSeries(c, p = 14) {
  const tr = [0];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  const o = new Array(c.length).fill(null);
  if (c.length <= p) return o;
  let v = tr.slice(1, p + 1).reduce((a, b) => a + b, 0) / p;
  o[p] = v;
  for (let i = p + 1; i < c.length; i++) { v = (v * (p - 1) + tr[i]) / p; o[i] = v; }
  return o;
}

// จัดกลุ่มแท่ง 1 ชม. เป็นแท่งใหญ่ตาม bucketKey(timestamp) — คืนแท่ง OHLCV รวม volume จริง
function resample(hourly, bucketKeyFn) {
  const buckets = new Map();
  for (const c of hourly) {
    const key = bucketKeyFn(c.t);
    let b = buckets.get(key);
    if (!b) { b = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0, n: 1 }; buckets.set(key, b); }
    else { b.h = Math.max(b.h, c.h); b.l = Math.min(b.l, c.l); b.c = c.c; b.v += c.v || 0; b.n++; }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

const DAY = 86400e3;
function bucket3Day(t) { return Math.floor(t / (3 * DAY)); }
function bucketWeek(t) { return Math.floor(t / (7 * DAY)); } // สัปดาห์ปฏิทินคร่าวๆ (นับจาก epoch ไม่ใช่ ISO week เป๊ะ)
function bucketMonth(t) { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }
function bucketQuarter(t) { const d = new Date(t); return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3); }
function bucketHalfYear(t) { const d = new Date(t); return d.getUTCFullYear() * 2 + Math.floor(d.getUTCMonth() / 6); }

function detectLongCandles(candles) {
  const atr = atrSeries(candles, 14);
  const out = [];
  for (let i = 14; i < candles.length; i++) {
    const c = candles[i], a = atr[i];
    if (!a) continue;
    const body = c.c - c.o;
    const bodyPct = Math.abs(body) / c.c * 100;
    const isLong = Math.abs(body) > ATR_MULT * a && bodyPct >= MIN_BODY_PCT;
    if (isLong) out.push({ i, t: c.t, body, bodyPct, direction: body > 0 ? "up" : "down", v: c.v, n: c.n });
  }
  return out;
}

function fmtDate(t) { return new Date(t).toISOString().slice(0, 10); }

function analyzeTimeframe(label, candles) {
  if (candles.length < 30) {
    console.log(`\n=== ${label} (${candles.length} แท่งเท่านั้น) ===`);
    console.log(`  ข้อมูลน้อยเกินไปจะสรุปอะไรได้จริงจัง (ATR(14) ต้องการอย่างน้อย 14 แท่งตั้งต้น เหลือให้วิเคราะห์แค่ ${Math.max(0, candles.length - 14)} แท่ง) — รายงานผลไว้เป็นข้อมูลดิบเท่านั้น อย่าตีความเป็นแพทเทิร์นที่เชื่อถือได้`);
  }
  const longs = detectLongCandles(candles);
  const up = longs.filter((s) => s.direction === "up").length;
  const down = longs.filter((s) => s.direction === "down").length;
  console.log(`\n=== ${label} (${candles.length} แท่ง จาก ${candles[0] ? fmtDate(candles[0].t) : "?"} ถึง ${candles.length ? fmtDate(candles[candles.length - 1].t) : "?"}) ===`);
  console.log(`  แท่งยาว (>${ATR_MULT}xATR และ >=${MIN_BODY_PCT}% body): ${longs.length} ครั้ง จากทั้งหมด ${candles.length} แท่ง (${(longs.length / Math.max(1, candles.length) * 100).toFixed(1)}%)`);
  console.log(`  เขียว(ขึ้น) ${up} / แดง(ลง) ${down}`);
  if (!longs.length) return longs;

  // ปีที่เกิดถี่สุด
  const byYear = {};
  for (const s of longs) { const y = new Date(s.t).getUTCFullYear(); byYear[y] = (byYear[y] || 0) + 1; }
  const yearsSorted = Object.entries(byYear).sort((a, b) => b[1] - a[1]);
  console.log(`  ปีที่เกิดถี่สุด: ${yearsSorted.slice(0, 3).map(([y, n]) => `${y} (${n} ครั้ง)`).join(", ")}`);

  // แท่งยาวที่สุด 3 อันดับแรก (body% มากสุด)
  const topBody = [...longs].sort((a, b) => b.bodyPct - a.bodyPct).slice(0, 3);
  console.log(`  แท่งยาวสุด 3 อันดับ: ${topBody.map((s) => `${fmtDate(s.t)} ${s.direction === "up" ? "เขียว" : "แดง"} ${s.bodyPct.toFixed(1)}%`).join(" | ")}`);

  return longs;
}

const hourly = JSON.parse(readFileSync(VOL_CACHE, "utf8"));
console.log(`ข้อมูลต้นทาง 1h ${hourly.length} แท่ง | ${fmtDate(hourly[0].t)} -> ${fmtDate(hourly[hourly.length - 1].t)}`);

const frames = [
  { label: "3 วัน", candles: resample(hourly, bucket3Day) },
  { label: "1 สัปดาห์", candles: resample(hourly, bucketWeek) },
  { label: "1 เดือน", candles: resample(hourly, bucketMonth) },
  { label: "3 เดือน (ไตรมาส)", candles: resample(hourly, bucketQuarter) },
  { label: "6 เดือน (ครึ่งปี)", candles: resample(hourly, bucketHalfYear) },
];

for (const f of frames) analyzeTimeframe(f.label, f.candles);
