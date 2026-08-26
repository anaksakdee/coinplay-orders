// วิเคราะห์แพทเทิร์นของ "ไม้ยาว" (spike) ในอดีต 5 ปี — หาว่ามีรูปแบบที่เทรดเดอร์รายใหญ่/บอทอัตโนมัติ
// มักทำซ้ำๆ หรือไม่ เพื่อประกอบการดูจังหวะที่อาจเกิดไม้ยาวในอนาคต (ไม่ใช่การเทรดอัตโนมัติ แค่รายงานวิเคราะห์)
//
// ใช้เกณฑ์ตรวจจับไม้ยาวเดียวกับระบบจริง (scripts/check-orders.mjs: detectSpike) เพื่อให้ผลตรงกับที่ระบบใช้จริง
// วิเคราะห์ 4 มุม: (1) ช่วงเวลาที่มักเกิด (ชม./วันในสัปดาห์) (2) ระดับราคาที่มักเกิด (เลขกลม/แนวรับ-ต้าน)
// (3) ความถี่ในการเกิดซ้ำ (จังหวะห่างกันคงที่ไหม) (4) ปริมาณซื้อขาย (volume) ตอนเกิดไม้ยาว
//
// รันเอง: node scripts/spike-pattern-analysis.mjs
import { readFileSync, writeFileSync, existsSync } from "fs";

const FEE = 0.001; // Binance — ใช้คำนวณ SPIKE_MIN_BODY ให้ตรงกับของจริง
const SPIKE_ATR_MULTIPLE = 1.5;
const SPIKE_RETRACE = 0.20;
const SPIKE_FEE_SAFETY = 2.5;
const SPIKE_MIN_BODY = (SPIKE_FEE_SAFETY * (2 * FEE * 100)) / SPIKE_RETRACE; // = 2.5%
const VOL_CACHE = "scripts/.cache/btc-1h-5y-vol.json";

async function fetchAllKlinesWithVolume() {
  if (existsSync(VOL_CACHE)) {
    console.log("ใช้ cache เดิม:", VOL_CACHE);
    return JSON.parse(readFileSync(VOL_CACHE, "utf8"));
  }
  console.log("ไม่มี cache ที่มี volume — ดึงใหม่จาก Binance (5 ปี, แบ่งหน้าละ 1000 แท่ง)...");
  const all = [];
  const now = Date.now();
  const fiveYearsMs = 5 * 365 * 86400e3;
  let startTime = now - fiveYearsMs;
  while (startTime < now) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=1000&startTime=${startTime}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("binance klines http " + res.status);
    const data = await res.json();
    if (!data.length) break;
    for (const k of data) all.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    startTime = data[data.length - 1][0] + 3600e3;
    process.stdout.write(`\r  ดึงแล้ว ${all.length} แท่ง...`);
    if (data.length < 1000) break;
  }
  console.log(`\nเสร็จ: ${all.length} แท่ง`);
  writeFileSync(VOL_CACHE, JSON.stringify(all));
  return all;
}

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

function detectSpikes(candles, atr) {
  const spikes = [];
  for (let i = 14; i < candles.length; i++) {
    const c = candles[i], a = atr[i];
    if (!a) continue;
    const body = c.c - c.o;
    const bodyPct = Math.abs(body) / c.c * 100;
    const isSpike = Math.abs(body) > SPIKE_ATR_MULTIPLE * a && bodyPct >= SPIKE_MIN_BODY;
    if (isSpike) spikes.push({ i, t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, body, bodyPct, direction: body > 0 ? "up" : "down" });
  }
  return spikes;
}

// ---------- 1) ช่วงเวลาที่มักเกิด ----------
function hourDowAnalysis(spikes) {
  const hourCount = new Array(24).fill(0), hourUp = new Array(24).fill(0), hourDown = new Array(24).fill(0);
  const dowCount = new Array(7).fill(0), dowUp = new Array(7).fill(0), dowDown = new Array(7).fill(0);
  const dowNames = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัส", "ศุกร์", "เสาร์"];
  for (const s of spikes) {
    const d = new Date(s.t);
    const h = d.getUTCHours(), dow = d.getUTCDay();
    hourCount[h]++; dowCount[dow]++;
    if (s.direction === "up") { hourUp[h]++; dowUp[dow]++; } else { hourDown[h]++; dowDown[dow]++; }
  }
  console.log("\n=== 1) ช่วงเวลาที่มักเกิดไม้ยาว (เวลา UTC — Bangkok = UTC+7) ===");
  console.log("ชม. (UTC) | รวม | เขียว(ขึ้น) | แดง(ลง) | % ของทั้งหมด");
  const total = spikes.length;
  const hourRanked = hourCount.map((n, h) => ({ h, n })).sort((a, b) => b.n - a.n);
  for (const { h, n } of hourRanked.slice(0, 8)) {
    const bkk = (h + 7) % 24;
    console.log(`  ${String(h).padStart(2, "0")}:00 UTC (${String(bkk).padStart(2, "0")}:00 ไทย) | ${n} | ${hourUp[h]} | ${hourDown[h]} | ${(n / total * 100).toFixed(1)}%`);
  }
  console.log("\nวันในสัปดาห์ (UTC):");
  for (let d = 0; d < 7; d++) {
    console.log(`  ${dowNames[d]}: รวม ${dowCount[d]} (เขียว ${dowUp[d]} / แดง ${dowDown[d]}) = ${(dowCount[d] / total * 100).toFixed(1)}%`);
  }
  const expectedPerHour = total / 24, expectedPerDow = total / 7;
  const chi2Hour = hourCount.reduce((a, n) => a + (n - expectedPerHour) ** 2 / expectedPerHour, 0);
  const chi2Dow = dowCount.reduce((a, n) => a + (n - expectedPerDow) ** 2 / expectedPerDow, 0);
  console.log(`\nนัยสำคัญทางสถิติ: chi-square (ชม.) = ${chi2Hour.toFixed(1)} (df=23, >35 ถือว่ามีนัยสำคัญที่ p<0.05)`);
  console.log(`                  chi-square (วัน) = ${chi2Dow.toFixed(1)} (df=6, >12.6 ถือว่ามีนัยสำคัญที่ p<0.05)`);
}

// ---------- 2) ระดับราคาที่มักเกิด (เลขกลม/แนวรับ-ต้าน) ----------
// วิธีวัดที่ถูกต้อง: ต้อง normalize ด้วยขนาดของเลขกลมเอง ไม่ใช่ "% ของราคา BTC" ตรงๆ
// เพราะ BTC ราคาหลักหมื่น เลขกลมเล็ก (เช่น $100) ระยะไกลสุดที่เป็นไปได้ (=R/2=$50) ก็แค่ ~0.07% ของราคาอยู่แล้ว
// ทำให้ "อยู่ภายใน 1% ของราคา" เกือบ 100% เสมอ "โดยบังเอิญล้วนๆ" ไม่เกี่ยวกับการกระจุกตัวจริง (เป็นกับดักที่ต้องระวัง)
// จึงวัดเป็นเศษส่วนของ R เอง: frac = ระยะห่างจากเลขกลมที่ใกล้ที่สุด / R  (มีค่า 0=อยู่บนเลขกลมพอดี ถึง 0.5=ไกลสุด)
// ถ้าไม่มีแพทเทิร์นจริง frac ควรกระจายสม่ำเสมอ 0-0.5 เฉลี่ย 0.25 — ถ้าเฉลี่ยจริงต่ำกว่านี้ชัดเจน = มีการกระจุกตัวจริง
function priceLevelAnalysis(spikes) {
  console.log("\n=== 2) ระดับราคาที่มักเกิดไม้ยาว (ปรับสเกลเทียบกับขนาดเลขกลมแล้ว — กันกับดักตัวเลขหลอกจากราคา BTC หลักหมื่น) ===");
  const rounds = [100, 500, 1000, 5000];
  for (const r of rounds) {
    const fracs = spikes.map((s) => {
      const rem = s.c % r;
      const distToNearest = Math.min(rem, r - rem);
      return distToNearest / r; // 0..0.5
    });
    const avgFrac = fracs.reduce((a, b) => a + b, 0) / fracs.length;
    const within10pctOfR = fracs.filter((f) => f < 0.05).length; // อยู่ในช่วง 10% แรก/ท้ายของเลขกลม
    console.log(`  รอบ $${r}: เศษส่วนระยะห่างเฉลี่ย ${avgFrac.toFixed(3)} (baseline สุ่ม=0.250, ยิ่งต่ำกว่านี้ยิ่งกระจุกตัวจริง) | ${within10pctOfR}/${spikes.length} (${(within10pctOfR / spikes.length * 100).toFixed(1)}%) อยู่ในช่วง 10% แรก/ท้ายของเลขกลม (baseline สุ่ม=10.0%)`);
  }
}

// ---------- 3) ความถี่ในการเกิดซ้ำ ----------
function recurrenceAnalysis(spikes) {
  console.log("\n=== 3) ความถี่ในการเกิดซ้ำ (ช่วงห่างระหว่างไม้ยาวติดกัน) ===");
  function stats(arr) {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    const sd = Math.sqrt(variance);
    return { mean, sd, cv: sd / mean };
  }
  const allGaps = [];
  for (let i = 1; i < spikes.length; i++) allGaps.push((spikes[i].t - spikes[i - 1].t) / 3600e3);
  const upGaps = [], downGaps = [];
  const upsOnly = spikes.filter((s) => s.direction === "up");
  const downsOnly = spikes.filter((s) => s.direction === "down");
  for (let i = 1; i < upsOnly.length; i++) upGaps.push((upsOnly[i].t - upsOnly[i - 1].t) / 3600e3);
  for (let i = 1; i < downsOnly.length; i++) downGaps.push((downsOnly[i].t - downsOnly[i - 1].t) / 3600e3);

  const all = stats(allGaps), up = stats(upGaps), down = stats(downGaps);
  console.log(`  ทั้งหมด: เฉลี่ยห่างกัน ${all.mean.toFixed(1)} ชม. | sd ${all.sd.toFixed(1)} | CV=${all.cv.toFixed(2)} (CV~1 = สุ่มแบบ Poisson, CV<0.5 = ค่อนข้างสม่ำเสมอ, CV>1.5 = กระจุกเป็นช่วงๆ)`);
  console.log(`  ไม้เขียว: เฉลี่ยห่างกัน ${up.mean.toFixed(1)} ชม. | sd ${up.sd.toFixed(1)} | CV=${up.cv.toFixed(2)}`);
  console.log(`  ไม้แดง:   เฉลี่ยห่างกัน ${down.mean.toFixed(1)} ชม. | sd ${down.sd.toFixed(1)} | CV=${down.cv.toFixed(2)}`);
}

// ---------- 4) ปริมาณซื้อขาย (volume) ตอนเกิดไม้ยาว ----------
function volumeAnalysis(spikes, candles) {
  console.log("\n=== 4) ปริมาณซื้อขาย (volume) ตอนเกิดไม้ยาว เทียบค่าเฉลี่ย 20 แท่งก่อนหน้า ===");
  const ratios = [];
  for (const s of spikes) {
    const window = candles.slice(Math.max(0, s.i - 20), s.i);
    if (!window.length) continue;
    const avgVol = window.reduce((a, c) => a + (c.v || 0), 0) / window.length;
    if (avgVol > 0) ratios.push(s.v / avgVol);
  }
  ratios.sort((a, b) => a - b);
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const median = ratios[Math.floor(ratios.length / 2)];
  const above2x = ratios.filter((r) => r > 2).length;
  const above3x = ratios.filter((r) => r > 3).length;
  console.log(`  volume ratio เฉลี่ย ${mean.toFixed(2)}x | median ${median.toFixed(2)}x ของค่าเฉลี่ย 20 แท่งก่อนหน้า`);
  console.log(`  ${above2x}/${ratios.length} (${(above2x / ratios.length * 100).toFixed(1)}%) volume สูงกว่าปกติ >2 เท่า`);
  console.log(`  ${above3x}/${ratios.length} (${(above3x / ratios.length * 100).toFixed(1)}%) volume สูงกว่าปกติ >3 เท่า`);
  console.log("  (volume สูงผิดปกติตอนไม้ยาว = สัญญาณว่ามีรายใหญ่/บอทเข้าซื้อ-ขายพร้อมกันจำนวนมาก ไม่ใช่แค่ความผันผวนเฉยๆ)");
}

const candles = await fetchAllKlinesWithVolume();
const days = ((candles[candles.length - 1].t - candles[0].t) / 86400e3).toFixed(0);
console.log(`ข้อมูลจริง BTCUSDT 1h ${candles.length} แท่ง (~${days} วัน) | ราคา ${candles[0].c.toFixed(0)} -> ${candles[candles.length - 1].c.toFixed(0)}`);

const atr = atrSeries(candles, 14);
const spikes = detectSpikes(candles, atr);
console.log(`พบไม้ยาวทั้งหมด ${spikes.length} ครั้ง (เขียว ${spikes.filter((s) => s.direction === "up").length} / แดง ${spikes.filter((s) => s.direction === "down").length}) — เกณฑ์เดียวกับระบบจริง (>${SPIKE_ATR_MULTIPLE}xATR และ >=${SPIKE_MIN_BODY.toFixed(2)}% ของราคา)`);

hourDowAnalysis(spikes);
priceLevelAnalysis(spikes);
recurrenceAnalysis(spikes);
volumeAnalysis(spikes, candles);
