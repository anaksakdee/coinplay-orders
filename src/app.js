import { app, auth, googleProvider, db, ADMIN_EMAIL, VAPID_PUBLIC_KEY, messagingSupported } from "./firebase.js";
import {
  signInWithPopup, signOut, onAuthStateChanged
} from "firebase/auth";
import {
  doc, getDoc, setDoc, updateDoc, addDoc, collection, arrayUnion,
  serverTimestamp, query, where, limit, getDocs
} from "firebase/firestore";
import { getMessaging, getToken, onMessage } from "firebase/messaging";
import { computeSignal } from "../shared/signals.mjs";

/* ---------------- helpers ---------------- */
var CCY = '$'; // สัญลักษณ์สกุลเงินของแหล่งราคาตลาดที่กำลังดูอยู่ (Binance=$ USD, Bitkub=฿ THB)
function fmtCcy(n, sym, d){
  d = d===undefined?2:d;
  var s = n<0 ? "-"+sym : sym;
  return s + Math.abs(n).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d});
}
// เงินในบัญชีเทรด/ราคาตลาดที่กำลังดูอยู่ (เปลี่ยนสัญลักษณ์ตามแท็บที่เลือก — Binance=USD, Bitkub=THB)
function fmtMkt(n, d){ return fmtCcy(n, CCY, d); }
function fmtBTC(n){ return n.toFixed(5) + " BTC"; }
function cssVar(name){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* ---------------- auth ---------------- */
var currentUid = null;
var currentEmail = null;
var currentAccount = null; // { email, displayName, createdAt, usd:{cash,btc,avgEntry,lots}, thb:{cash,btc,avgEntry,lots} }
var localTrades = [];
var sessionTrades = 0;

// บัญชีเทรดจำลองแยกกันคนละสกุลเงินต่อตลาด — Binance ใช้เงินดอลลาร์ (USD), Bitkub ใช้เงินบาท (THB)
var LEDGER_KEY = { binance:'usd', bitkub:'thb' };
var STARTING_BALANCE = { binance:300, bitkub:3000 };
var FEE_RATES = { binance:0.001, bitkub:0.0025 }; // Binance 0.10% มาตรฐาน, Bitkub 0.25% มาตรฐาน (ไม่รวมส่วนลด)
var QUICK_AMTS = { binance:[100,500,1000], bitkub:[5000,20000,50000] };
var TOPUP_QUICK = { binance:[1000,5000,10000], bitkub:[10000,50000,100000] };
var TOPUP_CAP = { binance:100000, bitkub:1000000 };

function ledger(){ return currentAccount ? currentAccount[LEDGER_KEY[activeExchange]] : null; }
function activeFeeRate(){ return FEE_RATES[activeExchange]; }

document.getElementById('btn-google').addEventListener('click', function(){
  var errEl = document.getElementById('login-error');
  errEl.textContent = '';
  signInWithPopup(auth, googleProvider).catch(function(err){
    errEl.textContent = 'เข้าสู่ระบบไม่สำเร็จ: ' + (err && err.message ? err.message : 'unknown error');
  });
});

document.getElementById('btn-logout').addEventListener('click', function(){
  var durSec = sessionStart ? Math.round((Date.now()-sessionStart)/1000) : 0;
  writeLog('logout', { sessionSeconds: durSec, tradesThisSession: sessionTrades }).finally(function(){
    signOut(auth);
  });
});

var sessionStart = null;

onAuthStateChanged(auth, function(user){
  if (!user){
    currentUid = null; currentEmail = null; currentAccount = null;
    document.getElementById('app-root').classList.add('hidden');
    document.getElementById('disclaimer-overlay').classList.add('hidden');
    document.getElementById('login-overlay').classList.remove('hidden');
    stopAllFeeds();
    marketStarted = false;
    return;
  }
  currentUid = user.uid;
  currentEmail = user.email;
  sessionStart = Date.now();
  sessionTrades = 0;

  document.getElementById('chip-name').textContent = user.displayName || user.email;
  document.getElementById('chip-avatar').src = user.photoURL || '';
  document.getElementById('admin-link').classList.toggle('hidden', user.email !== ADMIN_EMAIL);

  ensureUserDoc(user).then(function(){
    document.getElementById('login-overlay').classList.add('hidden');
    if (!currentAccount.disclaimerAcknowledged){
      document.getElementById('disclaimer-overlay').classList.remove('hidden');
      return;
    }
    enterApp();
  });
});

function enterApp(){
  document.getElementById('disclaimer-overlay').classList.add('hidden');
  document.getElementById('app-root').classList.remove('hidden');
  updateExchangeUI();
  loadTradeHistory();
  if (!marketStarted) startMarket();
  refreshNotifyButton();
}

/* ---------------- แจ้งเตือนในเบราว์เซอร์เมื่อมีการซื้อขาย (Web Push ผ่าน FCM) ----------------
   ทำงานได้แม้ปิดแท็บ/ปิดเบราว์เซอร์ เพราะ background job (check-orders.mjs) เป็นคนส่ง push มาโดยตรง
   ไม่ได้พึ่งหน้านี้เปิดค้างไว้ — ต่างจาก Notification API ธรรมดาที่ทำงานเฉพาะตอนแท็บเปิดอยู่เท่านั้น */
var messaging = null;

async function refreshNotifyButton(){
  var btn = document.getElementById('btn-notify');
  if (!btn) return;
  var supported = await messagingSupported;
  if (!supported){
    btn.textContent = '🔕 เบราว์เซอร์นี้ไม่รองรับ';
    btn.disabled = true;
    return;
  }
  if (typeof Notification === 'undefined'){
    btn.textContent = '🔕 เบราว์เซอร์นี้ไม่รองรับ';
    btn.disabled = true;
    return;
  }
  if (Notification.permission === 'granted'){
    btn.textContent = '🔔 แจ้งเตือนเปิดอยู่';
    btn.disabled = true;
  } else if (Notification.permission === 'denied'){
    btn.textContent = '🔕 ถูกบล็อกไว้ (แก้ในตั้งค่าเบราว์เซอร์)';
    btn.disabled = true;
  } else {
    btn.textContent = '🔔 เปิดแจ้งเตือน';
    btn.disabled = false;
  }
}

async function enableNotifications(){
  if (!currentUid) return;
  var btn = document.getElementById('btn-notify');
  var supported = await messagingSupported;
  if (!supported || typeof Notification === 'undefined'){
    alert('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือนแบบ Push');
    return;
  }
  try {
    var permission = await Notification.requestPermission();
    if (permission !== 'granted'){
      refreshNotifyButton();
      return;
    }
    var reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    if (!messaging) messaging = getMessaging(app);
    var token = await getToken(messaging, { vapidKey: VAPID_PUBLIC_KEY, serviceWorkerRegistration: reg });
    if (token){
      await updateDoc(doc(db, 'users', currentUid), { fcmTokens: arrayUnion(token) });
      writeLog('notifications_enabled', {});
    }
  } catch (err){
    console.error('enableNotifications failed', err);
    alert('เปิดการแจ้งเตือนไม่สำเร็จ: ' + (err && err.message ? err.message : 'unknown error'));
  }
  refreshNotifyButton();
}

document.getElementById('btn-notify').addEventListener('click', enableNotifications);

// ข้อความที่มาถึงตอนแท็บนี้เปิดอยู่และกำลัง focus (foreground) — FCM ไม่โชว์ popup ให้เองในเคสนี้
// ต้องดักด้วย onMessage แล้วสร้าง Notification เอง ต่างจากตอนปิดแท็บซึ่ง service worker จัดการให้อัตโนมัติ
messagingSupported.then(function(supported){
  if (!supported) return;
  messaging = getMessaging(app);
  onMessage(messaging, function(payload){
    var title = (payload.notification && payload.notification.title) || 'CoinPlay';
    var body = (payload.notification && payload.notification.body) || '';
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted'){
      new Notification(title, { body: body, icon: '/icon-512.png' });
    }
  });
});

document.getElementById('btn-acknowledge').addEventListener('click', function(){
  if (!currentAccount || !currentUid) return;
  currentAccount.disclaimerAcknowledged = true;
  updateDoc(doc(db,'users',currentUid), { disclaimerAcknowledged: true }).catch(function(err){ console.error('ack failed', err); });
  writeLog('disclaimer_acknowledged', {});
  enterApp();
});

var DCA_DEFAULT_AMT = { binance:20, bitkub:500 };
var AUTO_TRADE_DEFAULT_AMT = { binance:20, bitkub:500 };

function newDca(){
  return { enabled:false, amount:0, intervalHours:24, lastRun:null };
}
function newAutoTrade(){
  // roundTrips/btcAccumulated = ผลงานจริงของระบบตามเป้าหมาย "ได้จำนวน BTC เพิ่มขึ้น" (ไม่ใช่กำไรเป็นเงิน)
  return { enabled:false, buyAmount:0, lastBuyAt:null, roundTrips:0, btcAccumulated:0 };
}

function newLedger(startingCash){
  return { cash: startingCash, btc: 0, avgEntry: 0, lots: [], orders: [], dca: newDca(), lastSell: null, autoTrade: newAutoTrade() };
}

// สร้าง object เต็มของบัญชี (ทุกฟิลด์) เพื่อเขียนทับ Firestore แบบปลอดภัย — กันบั๊กเขียนทับฟิลด์อื่นหาย
// เวลามีจุดไหนใน code ที่ replace ทั้ง map (usd/thb) แทนที่จะใช้ dotted path update
function ledgerSnapshot(acc){
  return {
    cash: acc.cash, btc: acc.btc, avgEntry: acc.avgEntry, lots: acc.lots,
    orders: acc.orders || [], dca: acc.dca || newDca(),
    lastSell: acc.lastSell || null, autoTrade: acc.autoTrade || newAutoTrade()
  };
}

function ensureUserDoc(user){
  var ref = doc(db, 'users', user.uid);
  return getDoc(ref).then(function(snap){
    if (snap.exists()){
      currentAccount = snap.data();
      // migrate: บัญชีเก่าก่อนแยกเป็น usd/thb (เก็บ cash/btc/avgEntry/lots ไว้ที่ระดับบนสุด) -> ย้ายเข้า usd
      if (!currentAccount.usd){
        currentAccount.usd = {
          cash: currentAccount.cash!=null ? currentAccount.cash : 10000,
          btc: currentAccount.btc||0,
          avgEntry: currentAccount.avgEntry||0,
          lots: currentAccount.lots || (currentAccount.btc>0 ? [{ ts: Date.now(), qty: currentAccount.btc, price: currentAccount.avgEntry }] : []),
          orders: []
        };
      }
      if (!currentAccount.thb){
        currentAccount.thb = newLedger(STARTING_BALANCE.bitkub);
      }
      if (!currentAccount.usd.orders) currentAccount.usd.orders = [];
      if (!currentAccount.thb.orders) currentAccount.thb.orders = [];
      if (!currentAccount.usd.dca) currentAccount.usd.dca = newDca();
      if (!currentAccount.thb.dca) currentAccount.thb.dca = newDca();
      if (currentAccount.usd.lastSell===undefined) currentAccount.usd.lastSell = null;
      if (currentAccount.thb.lastSell===undefined) currentAccount.thb.lastSell = null;
      if (!currentAccount.usd.autoTrade) currentAccount.usd.autoTrade = newAutoTrade();
      if (!currentAccount.thb.autoTrade) currentAccount.thb.autoTrade = newAutoTrade();
      return writeLog('login', {});
    } else {
      currentAccount = {
        email: user.email, displayName: user.displayName||'',
        usd: newLedger(STARTING_BALANCE.binance),
        thb: newLedger(STARTING_BALANCE.bitkub),
        disclaimerAcknowledged: false,
        createdAt: serverTimestamp()
      };
      return setDoc(ref, currentAccount).then(function(){
        return writeLog('signup', { startingCashUsd: STARTING_BALANCE.binance, startingCashThb: STARTING_BALANCE.bitkub });
      });
    }
  }).catch(function(err){
    console.error('ensureUserDoc failed', err);
    currentAccount = currentAccount || { usd: newLedger(STARTING_BALANCE.binance), thb: newLedger(STARTING_BALANCE.bitkub) };
  });
}

function writeLog(type, detail){
  if (!currentUid) return Promise.resolve();
  return addDoc(collection(db, 'logs'), {
    uid: currentUid, email: currentEmail, type: type, detail: detail || {}, ts: serverTimestamp()
  }).catch(function(err){ console.error('writeLog failed', err); });
}

function loadTradeHistory(){
  var q = query(collection(db, 'trades'), where('uid', '==', currentUid), limit(50));
  getDocs(q).then(function(snap){
    localTrades = [];
    snap.forEach(function(d){ localTrades.push(d.data()); });
    localTrades.sort(function(a,b){
      var ta = a.ts && a.ts.toMillis ? a.ts.toMillis() : 0;
      var tb = b.ts && b.ts.toMillis ? b.ts.toMillis() : 0;
      return tb - ta;
    });
    localTrades = localTrades.slice(0, 30);
    renderHistory();
  }).catch(function(err){ console.error('loadTradeHistory failed', err); });
}

/* ---------------- real market data (Binance public API, or Bitkub via proxy) ---------------- */
var SYMBOL = 'btcusdt';
var KLINE_LIMIT = 120;
var TF_STORAGE_KEY = 'coinplay-timeframe';
var VALID_TFS = ['1m','5m','15m','1h','1d','1M'];
function loadSavedTimeframe(){
  try {
    var v = localStorage.getItem(TF_STORAGE_KEY);
    return VALID_TFS.indexOf(v)>=0 ? v : '1m';
  } catch(e){ return '1m'; }
}
var timeframe = loadSavedTimeframe();
var activeExchange = 'binance'; // 'binance' | 'bitkub'
var price = null;
var dayHigh = null, dayLow = null, dayChangePct = 0, dayVolumeBase = 0;
var candles = [];
var bookBids = [], bookAsks = [];
var returns = [];
var marketStarted = false;
var ws = null;
var reconnectTimer = null;

// Bitkub's public API doesn't send CORS headers for browser requests, so requests
// go through a free public CORS proxy. This is a third-party dependency — if it's
// ever slow/down, the Bitkub tab's live data will be affected (Binance is unaffected).
var BITKUB_PROXY_PREFIX = 'https://proxy.cors.sh/';
var BITKUB_RES = { '1m':'1', '5m':'5', '15m':'15', '1h':'60', '1d':'1D', '1M':'1M' };
function bitkubBarSeconds(res){
  if (res==='1D') return 86400;
  if (res==='1M') return 30*86400; // ประมาณค่าคร่าวๆ แค่ใช้กะช่วง from-to กว้างพอ ไม่ต้องเป๊ะ
  return parseInt(res,10)*60;
}
var bitkubTickerTimer = null;
var bitkubHistoryTimer = null;

function stopAllFeeds(){
  if (ws){ try{ ws.onclose=null; ws.close(); }catch(e){} ws=null; }
  if (reconnectTimer){ clearTimeout(reconnectTimer); reconnectTimer=null; }
  if (bitkubTickerTimer){ clearInterval(bitkubTickerTimer); bitkubTickerTimer=null; }
  if (bitkubHistoryTimer){ clearInterval(bitkubHistoryTimer); bitkubHistoryTimer=null; }
}

function switchExchange(ex){
  if (ex===activeExchange) return;
  activeExchange = ex;
  updateExchangeUI();
  if (!marketStarted) return; // ยังไม่ล็อกอิน/ยังไม่เริ่มตลาด แค่จำแท็บที่เลือกไว้ก่อน
  stopAllFeeds();
  price = null; candles = []; returns = []; bookBids = []; bookAsks = [];
  dayHigh = null; dayLow = null; dayChangePct = 0; dayVolumeBase = 0;
  lastForecast = null; forecastCounter = 0;
  startActiveExchangeFeed();
}

function updateExchangeUI(){
  CCY = activeExchange==='bitkub' ? '฿' : '$';
  document.getElementById('pair-label').textContent = activeExchange==='bitkub' ? 'BTC / THB' : 'BTC / USDT';
  document.querySelectorAll('.exchange-tab').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-exchange')===activeExchange);
  });
  // Bitkub ไม่มีข้อมูลออเดอร์บุ๊กแบบเรียลไทม์ที่ใช้งานได้ (endpoint ของ Bitkub เองล่ม) — ซ่อนพาเนลนี้เฉพาะแท็บนี้
  document.getElementById('book-panel').classList.toggle('hidden', activeExchange==='bitkub');
  document.getElementById('bitkub-note-panel').classList.toggle('hidden', activeExchange!=='bitkub');
  var badge = document.querySelector('.sim-badge');
  if (badge) badge.innerHTML = activeExchange==='bitkub'
    ? '<span class="dot"></span>ราคาจริงจาก Bitkub เรียลไทม์ · เทรดด้วยเงินบาทจำลอง (บัญชีแยกจาก Binance)'
    : '<span class="dot"></span>ราคาจริงจาก Binance เรียลไทม์ · เทรดด้วยเงินดอลลาร์จำลอง';

  renderQuickAmtButtons();
  document.getElementById('amt-input').value = QUICK_AMTS[activeExchange][1];
  document.getElementById('topup-input').value = TOPUP_QUICK[activeExchange][1];
  document.getElementById('amt-input').placeholder = 'จำนวนเงิน ('+(activeExchange==='bitkub'?'THB':'USD')+')';
  document.getElementById('topup-input').placeholder = 'จำนวนเงินที่เติม ('+(activeExchange==='bitkub'?'THB':'USD')+')';
  document.getElementById('fee-note').textContent = 'คิดค่าธรรมเนียม '+(activeFeeRate()*100).toFixed(2)+'% ต่อคำสั่ง (เท่ากับอัตรามาตรฐานของ'+(activeExchange==='bitkub'?'Bitkub':'Binance')+') หักจากเงินสดอัตโนมัติทุกครั้งที่ซื้อ/ขาย';
  document.getElementById('topup-note').textContent = 'เป็นเงินจำลองสำหรับฝึกเทรดเท่านั้น ไม่ใช่เงินจริง เติมได้ไม่จำกัดจำนวนครั้ง แต่ละครั้งไม่เกิน '+fmtMkt(TOPUP_CAP[activeExchange],0)+' การเติมเงินจะถูกบันทึกไว้เพื่อการวิเคราะห์เช่นกัน';

  if (currentAccount){ renderAccount(); renderHistory(); renderPendingOrders(); renderDcaPanel(); renderAutoTradePanel(); }
  if (marketStarted){ renderTradePoints(); renderSellPlan(); }
}

function renderQuickAmtButtons(){
  var tradeEl = document.getElementById('trade-quick-amts');
  var amts = QUICK_AMTS[activeExchange];
  tradeEl.innerHTML = amts.map(function(a){
    return '<button type="button" data-amt="'+a+'">'+fmtMkt(a,0)+'</button>';
  }).join('') + '<button type="button" data-amt="max">สูงสุด</button>';
  wireTradeQuickAmts();

  var topupEl = document.getElementById('topup-quick-amts');
  var tAmts = TOPUP_QUICK[activeExchange];
  topupEl.innerHTML = tAmts.map(function(a){
    return '<button type="button" class="topup-amt" data-amt="'+a+'">+'+fmtMkt(a,0)+'</button>';
  }).join('');
  wireTopupQuickAmts();
}

function stdev(arr){
  if (arr.length<2) return 0;
  var m = arr.reduce(function(a,b){return a+b;},0)/arr.length;
  var v = arr.reduce(function(a,b){return a+(b-m)*(b-m);},0)/(arr.length-1);
  return Math.sqrt(v);
}

function computeReturnsFromCandles(){
  returns = [];
  for (var i=1;i<candles.length;i++){
    var prevC = candles[i-1].c, curC = candles[i].c;
    if (prevC>0 && curC>0) returns.push(Math.log(curC/prevC));
  }
  if (returns.length>150) returns = returns.slice(-150);
}

function loadHistory(tf){
  var url = 'https://api.binance.com/api/v3/klines?symbol='+SYMBOL.toUpperCase()+'&interval='+tf+'&limit='+KLINE_LIMIT;
  return fetch(url).then(function(res){ return res.json(); }).then(function(data){
    candles = data.map(function(k){
      return { t:k[0], o:parseFloat(k[1]), h:parseFloat(k[2]), l:parseFloat(k[3]), c:parseFloat(k[4]) };
    });
    if (!price && candles.length) price = candles[candles.length-1].c;
    computeReturnsFromCandles();
  }).catch(function(err){ console.error('loadHistory failed', err); });
}

function connectStream(tf){
  if (ws){ try{ ws.onclose=null; ws.close(); }catch(e){} ws=null; }
  if (reconnectTimer){ clearTimeout(reconnectTimer); reconnectTimer=null; }
  var streams = SYMBOL+'@ticker/'+SYMBOL+'@kline_'+tf+'/'+SYMBOL+'@depth20@1000ms';
  ws = new WebSocket('wss://stream.binance.com:9443/stream?streams='+streams);
  ws.onmessage = function(ev){
    var msg;
    try { msg = JSON.parse(ev.data); } catch(e){ return; }
    var stream = msg.stream, d = msg.data;
    if (!stream || !d) return;
    if (stream.indexOf('@ticker')>=0){
      price = parseFloat(d.c);
      dayHigh = parseFloat(d.h);
      dayLow = parseFloat(d.l);
      dayChangePct = parseFloat(d.P);
      dayVolumeBase = parseFloat(d.v);
      onMarketUpdate();
    } else if (stream.indexOf('@kline_')>=0){
      var k = d.k;
      var t = k.t, o=parseFloat(k.o), h=parseFloat(k.h), l=parseFloat(k.l), c=parseFloat(k.c);
      var last = candles[candles.length-1];
      if (last && last.t === t){
        last.o=o; last.h=h; last.l=l; last.c=c;
      } else {
        candles.push({t:t,o:o,h:h,l:l,c:c});
        if (candles.length>KLINE_LIMIT) candles.shift();
        computeReturnsFromCandles();
      }
      if (!price) price = c;
      onMarketUpdate();
    } else if (stream.indexOf('@depth20')>=0){
      bookBids = (d.bids||[]).map(function(b){ return {price:parseFloat(b[0]), qty:parseFloat(b[1])}; });
      bookAsks = (d.asks||[]).map(function(a){ return {price:parseFloat(a[0]), qty:parseFloat(a[1])}; });
      renderBook();
    }
  };
  ws.onclose = function(){
    reconnectTimer = setTimeout(function(){ if (marketStarted) connectStream(timeframe); }, 3000);
  };
  ws.onerror = function(){ try{ ws.close(); }catch(e){} };
}

function computeForecast(){
  if (!price || candles.length<5) return null;
  var horizon = 20;
  var sigma = stdev(returns) || 0.001;
  var recent = returns.slice(-30);
  var drift = recent.length ? recent.reduce(function(a,b){return a+b;},0)/recent.length : 0;
  var paths = 250;
  var finals = [];
  var seriesSum = new Array(horizon).fill(0);
  for (var p=0; p<paths; p++){
    var pr = price;
    for (var i=0;i<horizon;i++){
      var shock = (Math.random()+Math.random()+Math.random()-1.5)/1.5;
      pr = pr * (1 + drift*0.6 + shock*sigma);
      seriesSum[i]+=pr;
    }
    finals.push(pr);
  }
  finals.sort(function(a,b){return a-b;});
  var median = finals[Math.floor(paths/2)];
  var p10 = finals[Math.floor(paths*0.10)];
  var p90 = finals[Math.floor(paths*0.90)];
  var upCount = finals.filter(function(f){return f>price;}).length;
  var probUp = upCount/paths;
  var medianSeries = seriesSum.map(function(s){return s/paths;});
  return {horizon:horizon, median:median, p10:p10, p90:p90, probUp:probUp, medianSeries:medianSeries};
}

/* ---------------- จุดซื้อ-ขายแนะนำ (buy/sell point recommendations) ---------------- */
var PROFIT_TARGET = 0.02; // เป้าหมายกำไรขั้นต่ำต่อรอบ 2%
var STOP_LOSS_PCT = 0.02; // ตัดขาดทุนเมื่อขาดทุนเกิน 2% ระหว่างที่ตลาดมีความเสี่ยงขาลง

// ใช้ความน่าจะเป็นขาขึ้นจากคาดการณ์หลัก (การคาดการณ์ล่วงหน้า) เป็นสัญญาณความเสี่ยงขาลงระยะสั้น
function isBearish(){
  return !!(lastForecast && lastForecast.probUp < 0.45);
}

// การขายล่าสุดของตลาดที่กำลังดูอยู่ — ใช้เป็นจุดอ้างอิงคำนวณจุดซื้อรอบถัดไป
function getLastSell(){
  for (var i=0;i<localTrades.length;i++){
    var t = localTrades[i];
    if ((t.market||'binance')===activeExchange && t.side==='sell') return t;
  }
  return null;
}
function getRecentSells(n){
  return localTrades.filter(function(t){ return (t.market||'binance')===activeExchange && t.side==='sell'; }).slice(0, n||5);
}

// จุดซื้อแนะนำ:
// 1) ถ้ามีประวัติขายล่าสุด — เป้าหมายเชิงกลไกคือราคาต่ำกว่าที่ขายไปอย่างน้อย 2% (ได้ปริมาณเหรียญมากกว่าที่ขายไป)
// 2) แต่ก่อนใช้เป้าหมายนั้น เช็คคาดการณ์ก่อนว่าราคามีโอกาสลงไปถึงจุดนั้นจริงไหม —
//    ถ้าโมเดลบอกว่าราคาไม่น่าจะลงไปมากกว่า 2% จากปัจจุบันแล้ว (ไม่มีโอกาสลงถึงเป้าหมายเชิงกลไก)
//    ให้ใช้แนวรับที่คาดการณ์จริง (หรือราคาปัจจุบันถ้าคาดว่าจะไม่ลงเลย) เป็นจุดซื้อแทน จะได้ไม่รอจุดที่ไม่มีทางถึง
// 3) ไม่ว่าจะเลือกจุดไหน คำนวณเป้าหมายขายที่ให้กำไร 2% ไว้ล่วงหน้าเสมอ ก่อนตัดสินใจซื้อจริง
function computeBuyPoint(){
  if (!price || !lastForecast) return null;
  var lastSell = getLastSell();
  var feeRate = activeFeeRate();
  var forecastFloor = lastForecast.p10;
  var possibleDropPct = Math.max(0, (price-forecastFloor)/price*100);
  var limitedDownside = possibleDropPct < PROFIT_TARGET*100; // โมเดลไม่คาดว่าจะลงเกิน 2% จากนี้

  var mechanicalTarget = lastSell ? lastSell.price/(1+PROFIT_TARGET) : null;
  var targetPrice, reason;
  if (limitedDownside){
    targetPrice = Math.min(price, forecastFloor);
    reason = 'limited-downside';
  } else if (mechanicalTarget!=null){
    targetPrice = mechanicalTarget;
    reason = 'edge-vs-last-sell';
  } else {
    targetPrice = forecastFloor;
    reason = 'forecast-floor';
  }

  var sellTargetIfBuyHere = targetPrice*(1+PROFIT_TARGET)/(1-feeRate);
  var qtyEdgePct = lastSell ? (((lastSell.usd/targetPrice)/lastSell.qty)-1)*100 : null;

  return {
    hasSellReference: !!lastSell, lastSell:lastSell, targetPrice:targetPrice,
    sellTargetIfBuyHere:sellTargetIfBuyHere, ready: price<=targetPrice,
    qtyEdgePct:qtyEdgePct, limitedDownside:limitedDownside, possibleDropPct:possibleDropPct, reason:reason
  };
}

function renderTradePoints(){
  var el = document.getElementById('horizon-list');
  if (!el) return;
  var bp = computeBuyPoint();
  if (!bp){
    el.innerHTML = '<div class="history-empty">กำลังโหลดข้อมูลคาดการณ์...</div>';
    return;
  }
  var recentSells = getRecentSells(5);
  var readyBadge = bp.ready ? '<span class="point-badge badge-ready">ถึงจุดซื้อแล้ว</span>' : '<span class="point-badge badge-wait">รอราคาลง</span>';
  var targetPct = (PROFIT_TARGET*100).toFixed(1).replace(/\.0$/,'');
  var limitedBadge = bp.limitedDownside ? '<span class="point-badge badge-neutral">คาดว่าลงได้ไม่ถึง '+targetPct+'%</span>' : '';
  var distPct = (price-bp.targetPrice)/price*100;

  var reasonText;
  if (bp.reason==='limited-downside'){
    reasonText = 'แบบจำลองคาดว่าราคามีโอกาสลงจากปัจจุบันอีกประมาณ '+bp.possibleDropPct.toFixed(2)+'% เท่านั้น (ไม่ถึงเกณฑ์ '+targetPct+'%) จึงใช้แนวรับที่คาดการณ์จริงเป็นจุดซื้อ แทนที่จะรอจุดที่ไม่มีโอกาสถึง';
  } else if (bp.reason==='edge-vs-last-sell'){
    reasonText = 'อ้างอิงจากการขายล่าสุด '+fmtMkt(bp.lastSell.price,0)+' × '+bp.lastSell.qty.toFixed(5)+' BTC — ที่ราคาเป้าหมายนี้จะได้ ~'+bp.qtyEdgePct.toFixed(2)+'% มากกว่าจำนวนเหรียญที่ขายไป';
  } else {
    reasonText = 'ยังไม่มีประวัติการขายในตลาดนี้ ใช้แนวรับที่คาดการณ์จากราคาปัจจุบันเป็นจุดซื้อ';
  }

  var buyAmt = bp.hasSellReference ? bp.lastSell.usd : parseFloat((document.getElementById('amt-input')||{}).value)||0;
  var acc0 = ledger();
  var existingBuyOrder = acc0 && acc0.orders ? acc0.orders.find(function(o){ return o.side==='buy' && Math.abs(o.targetPrice-bp.targetPrice)<bp.targetPrice*0.0005; }) : null;
  var actionsHtml;
  if (bp.ready){
    actionsHtml = '<div class="point-actions"><button type="button" class="btn-mini mini-buy" id="btn-buy-point">ซื้อตอนนี้ตามเป้าหมาย'+(bp.hasSellReference?' ('+fmtMkt(bp.lastSell.usd,0)+')':'')+'</button></div>';
  } else if (existingBuyOrder){
    actionsHtml = '<div class="point-actions"><button type="button" class="btn-mini mini-buy" disabled>ตั้งคำสั่งรอราคานี้ไว้แล้ว</button></div>';
  } else {
    actionsHtml = '<div class="point-actions"><button type="button" class="btn-mini mini-buy" id="btn-order-buy-point" data-target="'+bp.targetPrice+'" data-amount="'+buyAmt+'">ตั้งคำสั่งซื้ออัตโนมัติที่ราคานี้</button></div>';
  }

  var html = '<div class="point-card">' +
    '<div class="point-head">'+readyBadge+limitedBadge+'</div>' +
    '<div class="point-price">เป้าหมายซื้อ: <b>'+fmtMkt(bp.targetPrice,0)+'</b> <span class="point-sub">(ราคาปัจจุบัน '+fmtMkt(price,0)+(bp.ready?' — ถึงจุดแล้ว':' — ห่างอีก '+distPct.toFixed(2)+'%')+')</span></div>' +
    '<div class="point-detail">'+reasonText+'</div>' +
    '<div class="point-detail">ถ้าซื้อที่ราคานี้ ต้องขายที่ <b>'+fmtMkt(bp.sellTargetIfBuyHere,0)+'</b> ขึ้นไปถึงจะได้กำไรสุทธิ '+targetPct+'% (คำนวณค่าธรรมเนียมไว้ล่วงหน้าแล้ว)</div>' +
    actionsHtml +
  '</div>';

  if (recentSells.length){
    html += '<div class="point-history"><div class="point-history-title">การขายล่าสุด '+recentSells.length+' ครั้ง (ใช้เทียบจุดซื้อ)</div>' +
      recentSells.map(function(t){
        var ms = t.ts && t.ts.toMillis ? t.ts.toMillis() : Date.now();
        var d = new Date(ms).toLocaleString(undefined,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
        return '<div class="point-history-row"><span>'+d+'</span><span>'+fmtMkt(t.price,0)+' × '+t.qty.toFixed(5)+' BTC</span></div>';
      }).join('') +
    '</div>';
  }

  el.innerHTML = html;
}

// จุดขายแนะนำ: อิงจากประวัติการซื้อจริงของคุณ "แต่ละรอบ" (FIFO lot) ไม่ใช่ยอดถัวเฉลี่ยรวม
// แต่ละรอบใช้ราคาซื้อจริงของรอบนั้นเป็นต้นทุน เป้าหมายกำไรอย่างน้อย 2% ต่อรอบ
// พร้อมจุดตัดขาดทุน + จุดกลับเข้าซื้อ เมื่อตลาดมีความเสี่ยงขาลง
function computeSellPlan(){
  var acc = ledger();
  if (!acc || !acc.lots || acc.lots.length===0 || !price) return null;
  var feeRate = activeFeeRate();
  var bearish = isBearish();
  var rounds = acc.lots.map(function(lot, idx){
    var targetSell = lot.price*(1+PROFIT_TARGET)/(1-feeRate);
    var stopLoss = lot.price*(1-STOP_LOSS_PCT);
    var pnlPct = (price/lot.price-1)*100;
    var atTarget = price>=targetSell;
    var atRisk = !atTarget && bearish && price<=stopLoss;
    var support = (lastForecast && lastForecast.p10) ? lastForecast.p10 : price*0.97;
    return { idx:idx, ts:lot.ts, qty:lot.qty, price:lot.price, targetSell:targetSell, stopLoss:stopLoss, pnlPct:pnlPct, atTarget:atTarget, atRisk:atRisk, support:support };
  });
  rounds.sort(function(a,b){ return b.ts - a.ts; });
  return { rounds: rounds };
}

function renderSellPlan(){
  var el = document.getElementById('sellplan-list');
  if (!el) return;
  var acc = ledger();
  if (!acc || !acc.lots || acc.lots.length===0){
    el.innerHTML = '<div class="history-empty">คุณยังไม่มี BTC ให้ขาย — ซื้อก่อนเพื่อดูจุดขายแนะนำตามรอบที่ซื้อจริง</div>';
    return;
  }
  var plan = computeSellPlan();
  if (!plan){
    el.innerHTML = '<div class="history-empty">กำลังโหลดราคา...</div>';
    return;
  }
  var acc0 = ledger();
  el.innerHTML = plan.rounds.map(function(r, i){
    var timeStr = new Date(r.ts).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
    var dateStr = new Date(r.ts).toLocaleDateString(undefined,{day:'2-digit',month:'2-digit'});
    var cost = r.qty*r.price;
    var badge, detail, actionsHtml;
    if (r.atTarget){
      badge = '<span class="point-badge badge-ready">ถึงเป้าหมายกำไรแล้ว ('+(r.pnlPct>=0?'+':'')+r.pnlPct.toFixed(2)+'%)</span>';
      detail = 'ขายตอนนี้ที่ '+fmtMkt(price,0)+' จะได้กำไรสุทธิอย่างน้อย '+(PROFIT_TARGET*100).toFixed(0)+'% ตามเป้าหมาย';
      actionsHtml = '<div class="lot-actions"><button type="button" class="btn-mini mini-sell" data-sell-qty="'+r.qty+'">ขายรอบนี้ทั้งหมด ('+r.qty.toFixed(5)+' BTC)</button></div>';
    } else if (r.atRisk){
      badge = '<span class="point-badge badge-risk">เสี่ยงขาดทุนเพิ่ม — ตลาดขาลง</span>';
      detail = 'ราคาต่ำกว่าจุดตัดขาดทุน ('+fmtMkt(r.stopLoss,0)+') และแนวโน้มระยะสั้นเป็นขาลง แนะนำขายตัดขาดทุนตอนนี้ ('+r.pnlPct.toFixed(2)+'%) แล้วรอกลับเข้าซื้อที่แนวรับ '+fmtMkt(r.support,0);
      actionsHtml = '<div class="lot-actions"><button type="button" class="btn-mini mini-sell" data-sell-qty="'+r.qty+'">ขายตัดขาดทุนตอนนี้ ('+r.qty.toFixed(5)+' BTC)</button></div>';
    } else {
      var dist = (r.targetSell-price)/price*100;
      badge = '<span class="point-badge badge-wait">รอราคาขึ้น</span>';
      detail = 'เป้าหมายขาย '+fmtMkt(r.targetSell,0)+' (อีก '+dist.toFixed(2)+'%) · จุดตัดขาดทุน '+fmtMkt(r.stopLoss,0)+' · ตอนนี้ '+(r.pnlPct>=0?'+':'')+r.pnlPct.toFixed(2)+'%';
      var existingSellOrder = acc0 && acc0.orders ? acc0.orders.find(function(o){ return o.side==='sell' && Math.abs(o.targetPrice-r.targetSell)<r.targetSell*0.0005; }) : null;
      if (existingSellOrder){
        actionsHtml = '<div class="lot-actions"><button type="button" class="btn-mini mini-sell" disabled>ตั้งคำสั่งรอราคานี้ไว้แล้ว</button></div>';
      } else {
        var sellAmt = r.qty*r.targetSell;
        actionsHtml = '<div class="lot-actions"><button type="button" class="btn-mini mini-sell" data-order-sell="1" data-target="'+r.targetSell+'" data-amount="'+sellAmt+'">ตั้งคำสั่งขายอัตโนมัติที่ราคานี้</button></div>';
      }
    }
    return '<div class="lot-card" data-lot-idx="'+r.idx+'">' +
      '<div class="lot-header"><span>รอบที่ '+(plan.rounds.length-i)+' — ซื้อ <b>'+r.qty.toFixed(5)+' BTC</b> ที่ <b>'+CCY+r.price.toLocaleString(undefined,{maximumFractionDigits:2})+'</b> เมื่อ '+dateStr+' '+timeStr+' · ต้นทุนรวม '+fmtMkt(cost)+'</span></div>' +
      '<div class="point-head">'+badge+'</div>' +
      '<div class="point-detail">'+detail+'</div>' +
      actionsHtml +
    '</div>';
  }).join('');
}

document.getElementById('sellplan-list').addEventListener('click', function(e){
  var btn = e.target.closest('.btn-mini');
  if (!btn || btn.disabled) return;
  if (btn.hasAttribute('data-order-sell')){
    var target = parseFloat(btn.getAttribute('data-target'));
    var amount = parseFloat(btn.getAttribute('data-amount'));
    createOrder('sell', target, amount);
    return;
  }
  var qty = parseFloat(btn.getAttribute('data-sell-qty'))||0;
  if (qty<=0 || !price) return;
  doTrade('sell', qty*price);
});

document.getElementById('horizon-list').addEventListener('click', function(e){
  var buyNowBtn = e.target.closest('#btn-buy-point');
  if (buyNowBtn && !buyNowBtn.disabled){
    var bp = computeBuyPoint();
    if (!bp || !bp.ready) return;
    var amt = bp.hasSellReference ? bp.lastSell.usd : parseFloat(document.getElementById('amt-input').value)||0;
    doTrade('buy', amt);
    return;
  }
  var orderBtn = e.target.closest('#btn-order-buy-point');
  if (orderBtn && !orderBtn.disabled){
    var target = parseFloat(orderBtn.getAttribute('data-target'));
    var amount = parseFloat(orderBtn.getAttribute('data-amount'));
    createOrder('buy', target, amount);
  }
});

document.getElementById('orders-list').addEventListener('click', function(e){
  var btn = e.target.closest('[data-cancel-order]');
  if (!btn) return;
  cancelOrder(btn.getAttribute('data-cancel-order'));
});

document.getElementById('btn-add-order').addEventListener('click', function(){
  var side = document.getElementById('order-side').value;
  var targetPrice = parseFloat(document.getElementById('order-price').value);
  var amount = parseFloat(document.getElementById('order-amount').value);
  if (!targetPrice || targetPrice<=0 || !amount || amount<=0) return;
  createOrder(side, targetPrice, amount);
  document.getElementById('order-price').value = '';
  document.getElementById('order-amount').value = '';
});

document.getElementById('history').addEventListener('click', function(e){
  var btn = e.target.closest('[data-row-action]');
  if (!btn) return;
  var row = btn.getAttribute('data-row');
  var input = document.querySelector('.history-row-amt[data-row="'+row+'"]');
  var amt = input ? parseFloat(input.value)||0 : 0;
  if (amt<=0) return;
  doTrade(btn.getAttribute('data-row-action'), amt);
});

document.getElementById('profit-target-input').addEventListener('input', function(e){
  var v = parseFloat(e.target.value);
  if (!v || v<=0) return;
  PROFIT_TARGET = v/100;
  if (marketStarted){ renderTradePoints(); renderSellPlan(); }
});

/* ---------------- trading ---------------- */
var tradeBusy = false;

function doTrade(side, amtRaw, horizonKey){
  if (!currentAccount || tradeBusy || !price) return;
  var amt = parseFloat(amtRaw)||0;
  if (amt<=0) return;
  var acc = ledger();
  var feeRate = activeFeeRate();
  if (side==="buy" && amt*(1+feeRate)>acc.cash) amt = acc.cash/(1+feeRate);
  if (side==="sell"){
    var maxSellAmt = acc.btc*price;
    if (amt>maxSellAmt) amt = maxSellAmt;
  }
  if (amt<=0.01){
    writeLog('insufficient_funds', {side:side, market:activeExchange});
    return;
  }
  var fee = amt*feeRate;
  var qty = amt/price;
  if (!acc.lots) acc.lots = [];
  if (side==="buy"){
    acc.lots.push({ ts: Date.now(), qty: qty, price: price });
    acc.btc += qty;
    acc.cash -= (amt + fee);
  } else {
    var remaining = qty;
    var newLots = [];
    for (var i=0; i<acc.lots.length; i++){
      var lot = acc.lots[i];
      if (remaining<=1e-9){ newLots.push(lot); continue; }
      if (lot.qty<=remaining){ remaining -= lot.qty; }
      else { newLots.push({ ts: lot.ts, qty: lot.qty-remaining, price: lot.price }); remaining = 0; }
    }
    acc.lots = newLots;
    acc.btc -= qty;
    acc.cash += (amt - fee);
    if (acc.btc < 1e-9) { acc.btc = 0; acc.lots = []; }
    acc.lastSell = { price: price, usd: amt, qty: qty, ts: Date.now() };
  }
  var lotsTotalCost = acc.lots.reduce(function(a,l){ return a + l.qty*l.price; }, 0);
  acc.avgEntry = acc.btc>0 ? lotsTotalCost/acc.btc : 0;
  var equity = acc.cash + acc.btc*price;
  var record = { uid: currentUid, email: currentEmail, market: activeExchange, ccy: LEDGER_KEY[activeExchange], side: side, price: price, qty: qty, usd: amt, fee: fee, equityAfter: equity, ts: serverTimestamp() };
  var logDetail = { market: activeExchange, side: side, price: Math.round(price*100)/100, amount: Math.round(amt*100)/100, fee: Math.round(fee*100)/100, equityAfter: Math.round(equity*100)/100 };
  if (horizonKey){ record.horizon = horizonKey; logDetail.horizon = horizonKey; }

  var updatePath = LEDGER_KEY[activeExchange];
  var updateObj = {};
  updateObj[updatePath] = ledgerSnapshot(acc);

  tradeBusy = true;
  setBusy(true);
  Promise.all([
    updateDoc(doc(db,'users',currentUid), updateObj),
    addDoc(collection(db,'trades'), record),
    writeLog('trade', logDetail)
  ]).then(function(){
    sessionTrades++;
    localTrades.unshift(record);
    if (localTrades.length>60) localTrades.length = 60;
    renderHistory();
  }).catch(function(err){
    console.error('trade failed', err);
  }).finally(function(){
    tradeBusy = false;
    setBusy(false);
    renderAccount();
    renderSellPlan();
  });
}

function doTopup(amtRaw){
  if (!currentAccount || tradeBusy) return;
  var amt = parseFloat(amtRaw)||0;
  if (amt<=0) return;
  var cap = TOPUP_CAP[activeExchange];
  if (amt>cap) amt = cap;
  var acc = ledger();
  var newCash = acc.cash + amt;
  var updatePath = LEDGER_KEY[activeExchange]+'.cash';
  var updateObj = {};
  updateObj[updatePath] = newCash;

  tradeBusy = true;
  setBusy(true);
  updateDoc(doc(db,'users',currentUid), updateObj)
    .then(function(){
      acc.cash = newCash;
      return writeLog('topup', { market: activeExchange, amount: Math.round(amt*100)/100 });
    })
    .catch(function(err){ console.error('topup failed', err); })
    .finally(function(){ tradeBusy=false; setBusy(false); renderAccount(); renderSellPlan(); });
}

function doReset(){
  if (!currentAccount || tradeBusy) return;
  var acc = ledger();
  var starting = STARTING_BALANCE[activeExchange];
  acc.cash = starting; acc.btc = 0; acc.avgEntry = 0; acc.lots = []; acc.orders = []; acc.dca = newDca(); acc.lastSell = null; acc.autoTrade = newAutoTrade();
  var updatePath = LEDGER_KEY[activeExchange];
  var updateObj = {};
  updateObj[updatePath] = ledgerSnapshot(acc);

  tradeBusy = true; setBusy(true);
  updateDoc(doc(db,'users',currentUid), updateObj)
    .then(function(){ return writeLog('reset_account', { market: activeExchange }); })
    .catch(function(err){ console.error('reset failed', err); })
    .finally(function(){ tradeBusy=false; setBusy(false); renderAccount(); renderSellPlan(); renderPendingOrders(); renderDcaPanel(); renderAutoTradePanel(); });
}

/* ---------------- DCA อัตโนมัติ (ซื้อ BTC จำนวนคงที่ตามรอบเวลา เพื่อเก็บสะสม) ---------------- */
// การยิงคำสั่งจริงทำที่ฝั่งเซิร์ฟเวอร์ (GitHub Actions cron รันทุก ~5 นาที ผ่าน Firebase Admin SDK)
// เพื่อให้ทำงานได้แม้ไม่เปิดหน้านี้ค้างไว้ — ฝั่งนี้มีหน้าที่แค่บันทึก/แสดงการตั้งค่าเท่านั้น
function saveDca(){
  if (!currentAccount || !currentUid) return;
  var acc = ledger();
  var enabled = document.getElementById('dca-enabled').checked;
  var amount = parseFloat(document.getElementById('dca-amount').value)||0;
  var intervalHours = parseFloat(document.getElementById('dca-interval').value)||24;
  if (enabled && amount<=0) return;
  acc.dca = { enabled: enabled, amount: amount, intervalHours: intervalHours, lastRun: (acc.dca && acc.dca.lastRun) || null };
  var updateObj = {};
  updateObj[LEDGER_KEY[activeExchange]+'.dca'] = acc.dca;
  updateDoc(doc(db,'users',currentUid), updateObj).catch(function(err){ console.error('saveDca failed', err); });
  writeLog('dca_settings_saved', { market:activeExchange, enabled:enabled, amount: Math.round(amount*100)/100, intervalHours: intervalHours });
  renderDcaPanel();
}

function intervalLabel(hours){
  if (hours>=168 && hours%168===0) return 'ทุก '+(hours/168)+' สัปดาห์';
  if (hours>=24 && hours%24===0) return 'ทุก '+(hours/24)+' วัน';
  return 'ทุก '+hours+' ชั่วโมง';
}

function renderDcaPanel(){
  var enabledEl = document.getElementById('dca-enabled');
  if (!enabledEl) return;
  var acc = ledger();
  var dca = (acc && acc.dca) || newDca();
  enabledEl.checked = !!dca.enabled;
  document.getElementById('dca-amount').value = dca.amount || DCA_DEFAULT_AMT[activeExchange];
  document.getElementById('dca-interval').value = String(dca.intervalHours || 24);

  var statusEl = document.getElementById('dca-status');
  if (!dca.enabled){
    statusEl.textContent = 'ยังไม่ได้เปิดใช้งาน — เปิดแล้วระบบจะซื้อ BTC ให้อัตโนมัติตามจำนวนเงินและรอบเวลาที่ตั้งไว้ ทำงานฝั่งเซิร์ฟเวอร์ (เช็คทุก ~5 นาที) ให้แม้ไม่เปิดหน้านี้ค้างไว้ก็ตาม';
  } else {
    var next = dca.lastRun ? dca.lastRun + dca.intervalHours*3600*1000 : Date.now();
    var nextStr = next<=Date.now() ? 'รอบถัดไปภายใน ~5 นาที' : new Date(next).toLocaleString(undefined,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    var lastStr = dca.lastRun ? new Date(dca.lastRun).toLocaleString(undefined,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : 'ยังไม่เคยทำงาน';
    statusEl.textContent = 'เปิดใช้งานอยู่ — ซื้อ '+fmtMkt(dca.amount,0)+' '+intervalLabel(dca.intervalHours)+' · ทำงานล่าสุด: '+lastStr+' · '+nextStr;
  }
}

document.getElementById('btn-save-dca').addEventListener('click', saveDca);

/* ---------------- ออโต้เทรดเต็มรูปแบบ (ซื้อ-ขายอัตโนมัติตามสัญญาณ) ---------------- */
// การตัดสินใจจริงทำที่ฝั่งเซิร์ฟเวอร์ (check-orders.mjs) โดยใช้โมเดลรวมสัญญาณเดียวกับที่แสดงผลตรงนี้
// (Monte Carlo + RSI + EMA trend + Bollinger Bands) เพื่อให้สิ่งที่เห็นตรงกับสิ่งที่ระบบใช้ตัดสินใจจริง
var lastSignal = null;

function saveAutoTrade(){
  if (!currentAccount || !currentUid) return;
  var acc = ledger();
  var enabled = document.getElementById('auto-trade-enabled').checked;
  var buyAmount = parseFloat(document.getElementById('auto-trade-amount').value)||0;
  if (enabled && buyAmount<=0) return;
  var prevAuto = acc.autoTrade || newAutoTrade();
  acc.autoTrade = {
    enabled: enabled, buyAmount: buyAmount, lastBuyAt: prevAuto.lastBuyAt || null,
    roundTrips: prevAuto.roundTrips || 0, btcAccumulated: prevAuto.btcAccumulated || 0
  };
  var updateObj = {};
  updateObj[LEDGER_KEY[activeExchange]+'.autoTrade'] = acc.autoTrade;
  updateDoc(doc(db,'users',currentUid), updateObj).catch(function(err){ console.error('saveAutoTrade failed', err); });
  writeLog('auto_trade_settings_saved', { market:activeExchange, enabled:enabled, buyAmount: Math.round(buyAmount*100)/100 });
  renderAutoTradePanel();
}

function renderAutoTradePanel(){
  var enabledEl = document.getElementById('auto-trade-enabled');
  if (!enabledEl) return;
  var acc = ledger();
  var at = (acc && acc.autoTrade) || newAutoTrade();
  enabledEl.checked = !!at.enabled;
  document.getElementById('auto-trade-amount').value = at.buyAmount || AUTO_TRADE_DEFAULT_AMT[activeExchange];

  var statusEl = document.getElementById('auto-trade-status');
  var sigEl = document.getElementById('auto-trade-signal');
  if (!at.enabled){
    statusEl.textContent = 'ยังไม่ได้เปิดใช้งาน — เปิดแล้วระบบจะซื้อตอนสัญญาณบ่งชี้จุดซื้อ และขายทำกำไร/ตัดขาดทุนให้เองอัตโนมัติ ทำงานฝั่งเซิร์ฟเวอร์ (เช็คทุก ~5 นาที) ให้แม้ไม่เปิดหน้านี้ค้างไว้';
  } else {
    var lastBuyStr = at.lastBuyAt ? new Date(at.lastBuyAt).toLocaleString(undefined,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : 'ยังไม่เคยซื้อ';
    statusEl.textContent = 'เปิดใช้งานอยู่ — ซื้อทันทีที่คะแนนสัญญาณถึงเกณฑ์ (ไม่มีคูลดาวน์ กันพลาดจังหวะ) · ขายทำกำไร 2%/รอบ หรือตัดขาดทุนเฉพาะตอนจำเป็นจริงๆ (ขาดทุนหนัก 5% + สัญญาณยืนยันขาลง) · ซื้อล่าสุด: '+lastBuyStr;
  }

  // ป้ายคะแนนตามเป้าหมายจริงของระบบ: ได้จำนวน BTC เพิ่มขึ้นเท่าไหร่จากการเทรดครบวง (ไม่ใช่กำไรเป็นเงิน)
  var scoreEl = document.getElementById('auto-trade-score');
  if (scoreEl){
    var trips = at.roundTrips || 0;
    var gained = at.btcAccumulated || 0;
    if (!trips){
      scoreEl.innerHTML = '<b>ผลสะสม BTC จากออโต้เทรด:</b> ยังไม่มีรอบเทรดที่ครบวง (นับเมื่อ "ขายแล้วซื้อคืนสำเร็จ" 1 รอบ)';
    } else {
      var sign = gained>=0 ? '+' : '';
      var col = gained>0 ? 'var(--up)' : gained<0 ? 'var(--down)' : '';
      scoreEl.innerHTML = '<b>ผลสะสม BTC จากออโต้เทรด:</b> <span style="color:'+col+'">'+sign+gained.toFixed(8)+' BTC</span> จาก '+trips+' รอบที่ครบวง (ขาย→ซื้อคืน)';
    }
  }

  if (!sigEl) return;
  if (!lastSignal || !lastSignal.forecast){
    sigEl.textContent = 'กำลังโหลดสัญญาณ...';
    return;
  }
  var s = lastSignal;
  var trendTxt = s.trendUp==null ? 'ไม่มีข้อมูล' : (s.trendUp ? 'ขาขึ้น (EMA9>EMA21)' : 'ขาลง (EMA9<EMA21)');
  var rsiTxt = s.rsi==null ? 'ไม่มีข้อมูล' : s.rsi.toFixed(1)+(s.overbought?' (ซื้อมากไป)':s.oversold?' (ขายมากไป)':'');
  var bbTxt = !s.bb ? 'ไม่มีข้อมูล' : (s.nearUpperBand?'ราคาชนกรอบบน':s.nearLowerBand?'ราคาชนกรอบล่าง':'อยู่ในกรอบปกติ');
  var macdTxt = !s.macd ? 'ไม่มีข้อมูล' : s.macd.histogram.toFixed(1)+(s.macdBullish?' (ขาขึ้น)':s.macdBearish?' (ขาลง)':'');
  var overallTxt = s.bearish ? 'สัญญาณรวม: เอนไปทางขาลง ('+s.bearishVotes+'/'+s.totalVotes+' เสียง)' : s.bullish ? 'สัญญาณรวม: เอนไปทางขาขึ้น ('+s.bullishVotes+'/'+s.totalVotes+' เสียง)' : 'สัญญาณรวม: กลางๆ ไม่ชัดเจน';
  sigEl.innerHTML = '<b>'+overallTxt+'</b> · แนวโน้ม (EMA): '+trendTxt+' · RSI(14): '+rsiTxt+' · Bollinger Bands: '+bbTxt+' · MACD: '+macdTxt+' · Monte Carlo ขึ้น '+Math.round(s.forecast.probUp*100)+'%';
}

document.getElementById('btn-save-auto-trade').addEventListener('click', saveAutoTrade);

/* ---------------- คำสั่งรอราคา (auto — ทำงานเฉพาะตอนเปิดหน้านี้ค้างไว้) ---------------- */
function createOrder(side, targetPrice, amount){
  if (!currentAccount || !targetPrice || targetPrice<=0 || !amount || amount<=0) return;
  var acc = ledger();
  if (!acc.orders) acc.orders = [];
  var order = { id: 'o'+Date.now().toString(36)+Math.random().toString(36).slice(2,7), side:side, targetPrice:targetPrice, amount:amount, createdAt: Date.now() };
  acc.orders.unshift(order);
  renderPendingOrders();
  var updateObj = {};
  updateObj[LEDGER_KEY[activeExchange]+'.orders'] = acc.orders;
  updateDoc(doc(db,'users',currentUid), updateObj).catch(function(err){ console.error('createOrder failed', err); });
  writeLog('order_created', { market:activeExchange, side:side, targetPrice: Math.round(targetPrice*100)/100, amount: Math.round(amount*100)/100 });
}

function cancelOrder(id){
  var acc = ledger();
  if (!acc || !acc.orders) return;
  acc.orders = acc.orders.filter(function(o){ return o.id!==id; });
  renderPendingOrders();
  var updateObj = {};
  updateObj[LEDGER_KEY[activeExchange]+'.orders'] = acc.orders;
  updateDoc(doc(db,'users',currentUid), updateObj).catch(function(err){ console.error('cancelOrder failed', err); });
  writeLog('order_cancelled', { market:activeExchange, id:id });
}

// เช็คทุกครั้งที่ราคาขยับ — ถ้าถึงเป้าหมายจะยิงคำสั่งซื้อ/ขายให้อัตโนมัติ (ทำงานได้เฉพาะตอนเปิดหน้านี้ค้างไว้เท่านั้น ไม่มีเซิร์ฟเวอร์คอยทำงานแทนตอนปิดแท็บ)
function checkPendingOrders(){
  if (!currentAccount || tradeBusy || !price) return;
  var acc = ledger();
  if (!acc || !acc.orders || !acc.orders.length) return;
  for (var i=0;i<acc.orders.length;i++){
    var o = acc.orders[i];
    var hit = (o.side==='buy' && price<=o.targetPrice) || (o.side==='sell' && price>=o.targetPrice);
    if (hit){
      acc.orders = acc.orders.filter(function(x){ return x.id!==o.id; });
      renderPendingOrders();
      writeLog('order_triggered', { market:activeExchange, side:o.side, targetPrice: Math.round(o.targetPrice*100)/100, amount: Math.round(o.amount*100)/100 });
      doTrade(o.side, o.amount);
      break;
    }
  }
}

function renderPendingOrders(){
  var el = document.getElementById('orders-list');
  if (!el) return;
  var acc = ledger();
  var orders = (acc && acc.orders) || [];
  if (!orders.length){
    el.innerHTML = '<div class="history-empty">ยังไม่มีคำสั่งรอราคา</div>';
    return;
  }
  el.innerHTML = orders.map(function(o){
    var sideLabel = o.side==='buy' ? 'ซื้อ' : 'ขาย';
    var sideClass = o.side==='buy' ? 'side-buy' : 'side-sell';
    return '<div class="order-row">' +
      '<span class="'+sideClass+'">'+sideLabel+'</span>' +
      '<span>ที่ '+fmtMkt(o.targetPrice,0)+'</span>' +
      '<span>'+fmtMkt(o.amount,0)+'</span>' +
      '<button type="button" class="btn-mini mini-sell" data-cancel-order="'+o.id+'">ยกเลิก</button>' +
    '</div>';
  }).join('');
}

function setBusy(b){
  ['btn-buy','btn-sell','btn-reset','btn-topup'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.disabled = b;
  });
  document.querySelectorAll('.btn-mini').forEach(function(el){ el.disabled = b; });
}

/* ---------------- rendering ---------------- */
var canvas, ctx, canvasSize;

function resizeCanvas(){
  canvas = document.getElementById('chart');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  var wrap = document.getElementById('chart-wrap');
  var w = wrap.clientWidth - 8;
  var h = 380;
  var dpr = window.devicePixelRatio||1;
  canvas.width = w*dpr; canvas.height = h*dpr;
  canvas.style.width = w+"px"; canvas.style.height = h+"px";
  ctx.setTransform(dpr,0,0,dpr,0,0);
  canvasSize = {w:w,h:h};
}

function drawChart(forecast){
  if (!ctx || !candles.length) return;
  var w = canvasSize.w, h = canvasSize.h;
  ctx.clearRect(0,0,w,h);
  var padL=54, padR=14, padT=14, padB=22;
  var plotW = w-padL-padR, plotH = h-padT-padB;

  var histN = candles.length;
  var forecastN = forecast ? forecast.horizon : 0;
  var totalN = histN + forecastN;
  if (totalN<2) return;

  var allLows = candles.map(function(c){return c.l;});
  var allHighs = candles.map(function(c){return c.h;});
  var lo = allLows.length?Math.min.apply(null, allLows):price*0.98;
  var hi = allHighs.length?Math.max.apply(null, allHighs):price*1.02;
  if (forecast){ lo = Math.min(lo, forecast.p10); hi = Math.max(hi, forecast.p90); }
  var pad = (hi-lo)*0.08 || price*0.01;
  lo -= pad; hi += pad;

  function xAt(i){ return padL + (i/(totalN-1))*plotW; }
  function yAt(v){ return padT + (1-(v-lo)/(hi-lo))*plotH; }

  var border = cssVar('--border');
  var faint = cssVar('--text-faint');
  var up = cssVar('--up');
  var down = cssVar('--down');
  var accent = cssVar('--accent');
  var accentSoft = cssVar('--accent-soft');

  ctx.strokeStyle = border; ctx.lineWidth=1;
  ctx.font = "10.5px " + (cssVar('--font-mono')||'monospace');
  ctx.fillStyle = faint;
  var gridLines = 4;
  for (var g=0; g<=gridLines; g++){
    var v = lo + (hi-lo)*g/gridLines;
    var y = yAt(v);
    ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke();
    ctx.fillText(CCY+v.toLocaleString(undefined,{maximumFractionDigits:0}), 4, y+3);
  }

  if (forecast){
    var xDiv = xAt(histN-1);
    ctx.setLineDash([3,3]);
    ctx.strokeStyle = faint;
    ctx.beginPath(); ctx.moveTo(xDiv,padT); ctx.lineTo(xDiv,h-padB); ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(xAt(histN-1), yAt(price));
    var i;
    for (i=0;i<forecastN;i++){
      var frac=(i+1)/forecastN;
      var bandHi = price + (forecast.p90-price)*frac;
      ctx.lineTo(xAt(histN+i), yAt(bandHi));
    }
    for (i=forecastN-1;i>=0;i--){
      var frac2=(i+1)/forecastN;
      var bandLo = price + (forecast.p10-price)*frac2;
      ctx.lineTo(xAt(histN+i), yAt(bandLo));
    }
    ctx.closePath();
    ctx.fillStyle = accentSoft;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(xAt(histN-1), yAt(price));
    forecast.medianSeries.forEach(function(v,idx){ ctx.lineTo(xAt(histN+idx), yAt(v)); });
    ctx.strokeStyle = accent; ctx.lineWidth=2; ctx.setLineDash([5,3]);
    ctx.stroke(); ctx.setLineDash([]);
  }

  var candleW = Math.max(2, plotW/totalN*0.6);
  candles.forEach(function(c,i){
    var x = xAt(i);
    var col = c.c>=c.o ? up : down;
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(x, yAt(c.h)); ctx.lineTo(x, yAt(c.l)); ctx.stroke();
    var yo = yAt(c.o), yc = yAt(c.c);
    var top = Math.min(yo,yc), bh = Math.max(1, Math.abs(yc-yo));
    ctx.fillRect(x-candleW/2, top, candleW, bh);
  });

  ctx.setLineDash([2,4]);
  ctx.strokeStyle = faint;
  var yp = yAt(price);
  ctx.beginPath(); ctx.moveTo(padL,yp); ctx.lineTo(w-padR,yp); ctx.stroke();
  ctx.setLineDash([]);
}

function renderTicker(){
  var priceValEl = document.getElementById('price-val');
  if (!priceValEl || !price) return;
  priceValEl.textContent = CCY+price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  var priceDeltaEl = document.getElementById('price-delta');
  priceDeltaEl.textContent = (dayChangePct>=0?"+":"")+dayChangePct.toFixed(2)+"% (24ชม.)";
  priceDeltaEl.className = "price-delta " + (dayChangePct>=0?"up":"down");
  document.getElementById('stat-high').textContent = dayHigh!=null ? CCY+dayHigh.toLocaleString(undefined,{maximumFractionDigits:0}) : "—";
  document.getElementById('stat-low').textContent = dayLow!=null ? CCY+dayLow.toLocaleString(undefined,{maximumFractionDigits:0}) : "—";
  var vol = stdev(returns)*100;
  document.getElementById('stat-vol').textContent = vol.toFixed(2)+"% / แท่ง";
  document.getElementById('stat-volu').textContent = dayVolumeBase.toLocaleString(undefined,{maximumFractionDigits:1})+" BTC";
}

function renderForecastPanel(f){
  document.getElementById('fc-target').textContent = CCY+f.median.toLocaleString(undefined,{maximumFractionDigits:0});
  var chg = (f.median-price)/price*100;
  var chgEl = document.getElementById('fc-change');
  chgEl.textContent = (chg>=0?"+":"")+chg.toFixed(2)+"%";
  chgEl.style.color = chg>=0 ? cssVar('--up') : cssVar('--down');
  document.getElementById('fc-lo').textContent = CCY+f.p10.toLocaleString(undefined,{maximumFractionDigits:0});
  document.getElementById('fc-hi').textContent = CCY+f.p90.toLocaleString(undefined,{maximumFractionDigits:0});
  var pctUp = Math.round(f.probUp*100);
  document.getElementById('prob-fill').style.width = pctUp+"%";
  document.getElementById('prob-up-lbl').textContent = "ขึ้น "+pctUp+"%";
  document.getElementById('prob-down-lbl').textContent = "ลง "+(100-pctUp)+"%";
}

function renderBook(){
  var bookEl = document.getElementById('book');
  if (!bookEl || !bookBids.length || !bookAsks.length) return;
  var levels = 6;
  var maxSize = Math.max.apply(null, bookBids.slice(0,levels).concat(bookAsks.slice(0,levels)).map(function(r){return r.qty;})) || 1;

  var asksTop = bookAsks.slice(0, levels).slice().reverse();
  var asksHtml = asksTop.map(function(r){
    var pct = Math.min(100, r.qty/maxSize*140);
    return '<div class="book-row ask"><div class="bar" style="width:'+pct+'%"></div><div class="cell price">$'+r.price.toFixed(1)+'</div><div class="cell">'+r.qty.toFixed(3)+'</div><div class="cell" style="text-align:right;color:var(--text-faint)">ขาย</div></div>';
  }).join('');

  var bidsHtml = bookBids.slice(0, levels).map(function(r){
    var pct = Math.min(100, r.qty/maxSize*140);
    return '<div class="book-row bid"><div class="bar" style="width:'+pct+'%"></div><div class="cell price">$'+r.price.toFixed(1)+'</div><div class="cell">'+r.qty.toFixed(3)+'</div><div class="cell" style="text-align:right;color:var(--text-faint)">ซื้อ</div></div>';
  }).join('');

  var spread = bookAsks[0].price - bookBids[0].price;
  var mid = (bookAsks[0].price + bookBids[0].price)/2;
  bookEl.innerHTML = asksHtml + '<div class="book-mid">กลาง $'+mid.toFixed(2)+' · ส่วนต่าง $'+spread.toFixed(2)+'</div>' + bidsHtml;
  document.getElementById('book-spread').textContent = "ส่วนต่าง $"+spread.toFixed(2);
}

function renderAccount(){
  var acc = ledger();
  if (!acc) return;
  document.getElementById('balance').textContent = fmtMkt(acc.cash);
  var equity = acc.cash + acc.btc*price;
  document.getElementById('equity').textContent = fmtMkt(equity);
  document.getElementById('pos-size').textContent = fmtBTC(acc.btc);
  document.getElementById('pos-entry').textContent = acc.btc>0 ? CCY+acc.avgEntry.toLocaleString(undefined,{maximumFractionDigits:2}) : "—";
  var pnl = acc.btc>0 ? (price-acc.avgEntry)*acc.btc : 0;
  var pnlEl = document.getElementById('pos-pnl');
  pnlEl.textContent = fmtMkt(pnl);
  pnlEl.style.color = pnl>0?cssVar('--up'):pnl<0?cssVar('--down'):'';
  var retPct = (equity-STARTING_BALANCE[activeExchange])/STARTING_BALANCE[activeExchange]*100;
  var retEl = document.getElementById('pos-ret');
  retEl.textContent = (retPct>=0?"+":"")+retPct.toFixed(2)+"%";
  retEl.style.color = retPct>0?cssVar('--up'):retPct<0?cssVar('--down'):'';
  document.getElementById('btn-sell').disabled = acc.btc<=0 || tradeBusy;
  document.getElementById('btn-buy').disabled = tradeBusy;
}

function renderHistory(){
  var el = document.getElementById('history');
  if (!el) return;
  var rowsSrc = localTrades.filter(function(t){ return (t.market||'binance')===activeExchange; });
  if (!rowsSrc.length){
    el.innerHTML = '<div class="history-empty">ยังไม่มีการเทรดในตลาดนี้ — ลองกดซื้อหรือขายดู</div>';
    return;
  }
  var rows = rowsSrc.map(function(t, i){
    var ms = t.ts && t.ts.toMillis ? t.ts.toMillis() : Date.now();
    var timeStr = new Date(ms).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    var sideLabel = t.side==='buy' ? 'ซื้อ' : 'ขาย';
    var defaultAmt = Math.round(t.usd*100)/100;
    return '<tr>' +
      '<td>'+timeStr+'</td>' +
      '<td class="side-'+t.side+'">'+sideLabel+'</td>' +
      '<td>'+CCY+t.price.toLocaleString(undefined,{maximumFractionDigits:2})+'</td>' +
      '<td>'+t.qty.toFixed(5)+'</td>' +
      '<td>'+fmtMkt(t.usd)+'</td>' +
      '<td><input type="number" class="history-row-amt" data-row="'+i+'" value="'+defaultAmt+'" min="0" step="10"></td>' +
      '<td><div class="history-row-actions"><button type="button" class="btn-mini mini-buy" data-row-action="buy" data-row="'+i+'">ซื้อ</button><button type="button" class="btn-mini mini-sell" data-row-action="sell" data-row="'+i+'">ขาย</button></div></td>' +
    '</tr>';
  }).join('');
  el.innerHTML = '<table><thead><tr><th>เวลา</th><th>ฝั่ง</th><th>ราคา</th><th>จำนวน (BTC)</th><th>มูลค่า</th><th>จำนวนเงินที่จะทำรายการ</th><th>ดำเนินการตอนนี้</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

var lastForecast = null;
var forecastCounter = 0;
function onMarketUpdate(){
  renderTicker();
  checkPendingOrders();
  forecastCounter++;
  if (!lastForecast || forecastCounter % 5 === 0){
    var f = computeForecast();
    if (f){ lastForecast = f; renderForecastPanel(lastForecast); }
    renderTradePoints();
    renderSellPlan();
    if (candles.length>=25){ lastSignal = computeSignal(price, candles, returns); renderAutoTradePanel(); }
  }
  drawChart(lastForecast);
  renderAccount();
}

/* ---------------- Bitkub feed (ผ่าน CORS proxy สาธารณะ) ---------------- */
function loadBitkubHistory(tf){
  var res = BITKUB_RES[tf] || '1';
  var now = Math.floor(Date.now()/1000);
  var barSeconds = (res==='60') ? 3600 : bitkubBarSeconds(res);
  var from = now - barSeconds*KLINE_LIMIT;
  var url = BITKUB_PROXY_PREFIX+'https://api.bitkub.com/tradingview/history?symbol=BTC_THB&resolution='+res+'&from='+from+'&to='+now;
  return fetch(url).then(function(r){ return r.json(); }).then(function(data){
    if (!data || !data.c || !data.t) { candles = []; return; }
    candles = data.t.map(function(t,i){
      return { t: t*1000, o:data.o[i], h:data.h[i], l:data.l[i], c:data.c[i] };
    });
    if (candles.length) price = candles[candles.length-1].c;
    computeReturnsFromCandles();
  }).catch(function(err){ console.error('loadBitkubHistory failed', err); });
}

function loadBitkubTicker(){
  fetch(BITKUB_PROXY_PREFIX+'https://api.bitkub.com/api/market/ticker').then(function(r){ return r.json(); }).then(function(data){
    var t = data && data.THB_BTC;
    if (!t) return;
    price = t.last;
    dayHigh = t.high24hr;
    dayLow = t.low24hr;
    dayChangePct = t.percentChange;
    dayVolumeBase = t.baseVolume;
    onMarketUpdate();
  }).catch(function(err){ console.error('loadBitkubTicker failed', err); });
}

function startBitkubFeed(tf){
  loadBitkubHistory(tf).then(function(){
    drawChart(null);
    loadBitkubTicker();
  });
  if (bitkubTickerTimer) clearInterval(bitkubTickerTimer);
  bitkubTickerTimer = setInterval(loadBitkubTicker, 3000);
  if (bitkubHistoryTimer) clearInterval(bitkubHistoryTimer);
  bitkubHistoryTimer = setInterval(function(){ loadBitkubHistory(tf); }, 15000);
}

function startActiveExchangeFeed(){
  resizeCanvas();
  if (activeExchange==='binance'){
    loadHistory(timeframe).then(function(){
      drawChart(null);
      connectStream(timeframe);
    });
  } else {
    startBitkubFeed(timeframe);
  }
}

function startMarket(){
  marketStarted = true;
  startActiveExchangeFeed();
}

function renderTfButtons(){
  document.querySelectorAll('.tf-btn').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-tf')===timeframe);
  });
}

function changeTimeframe(tf){
  if (tf===timeframe) return;
  timeframe = tf;
  try { localStorage.setItem(TF_STORAGE_KEY, tf); } catch(e){}
  renderTfButtons();
  price = null;
  if (activeExchange==='binance'){
    loadHistory(tf).then(function(){
      connectStream(tf);
      drawChart(lastForecast);
    });
  } else {
    startBitkubFeed(tf);
  }
}

window.addEventListener('resize', function(){ if (marketStarted){ resizeCanvas(); drawChart(lastForecast); } });

/* ---------------- wire up controls ---------------- */
function wireTradeQuickAmts(){
  document.querySelectorAll('#trade-quick-amts button').forEach(function(btn){
    btn.addEventListener('click', function(){
      var amt = btn.getAttribute('data-amt');
      var led = ledger();
      if (amt==='max' && led){
        document.getElementById('amt-input').value = Math.round(led.cash);
      } else if (amt!=='max'){
        document.getElementById('amt-input').value = amt;
      }
    });
  });
}
function wireTopupQuickAmts(){
  document.querySelectorAll('#topup-quick-amts button').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.getElementById('topup-input').value = btn.getAttribute('data-amt');
    });
  });
}

document.getElementById('btn-buy').addEventListener('click', function(){ doTrade('buy', document.getElementById('amt-input').value); });
document.getElementById('btn-sell').addEventListener('click', function(){ doTrade('sell', document.getElementById('amt-input').value); });
document.getElementById('btn-topup').addEventListener('click', function(){ doTopup(document.getElementById('topup-input').value); });
document.getElementById('btn-reset').addEventListener('click', doReset);
renderTfButtons();
document.getElementById('tf-group').addEventListener('click', function(e){
  var btn = e.target.closest('.tf-btn');
  if (btn) changeTimeframe(btn.getAttribute('data-tf'));
});
document.querySelectorAll('.exchange-tab').forEach(function(btn){
  btn.addEventListener('click', function(){ switchExchange(btn.getAttribute('data-exchange')); });
});
