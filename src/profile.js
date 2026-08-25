import { auth, googleProvider, db } from "./firebase.js";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, collection, getDocs, query, where, limit } from "firebase/firestore";

function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function fmtCcy(n, sym){ n = n||0; return sym+n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function tsToMs(ts){ return ts && ts.toMillis ? ts.toMillis() : 0; }
function fmtTime(ms){ return ms ? new Date(ms).toLocaleString(undefined,{dateStyle:'short',timeStyle:'medium'}) : '—'; }

var MARKET_LABELS = { binance: 'Binance (USD)', bitkub: 'Bitkub (THB)' };
var SLEEVE_LABELS = { core: 'สะสมระยะยาว', swing: 'เทรดสั้น' };

document.getElementById('btn-google').addEventListener('click', function(){
  var errEl = document.getElementById('login-error');
  errEl.textContent = '';
  signInWithPopup(auth, googleProvider).catch(function(err){
    errEl.textContent = 'เข้าสู่ระบบไม่สำเร็จ: ' + (err && err.message ? err.message : 'unknown error');
  });
});
document.getElementById('btn-logout').addEventListener('click', function(){ signOut(auth); });

onAuthStateChanged(auth, function(user){
  var loginOverlay = document.getElementById('login-overlay');
  var appRoot = document.getElementById('app-root');
  if (!user){
    loginOverlay.classList.remove('hidden');
    appRoot.classList.add('hidden');
    return;
  }
  loginOverlay.classList.add('hidden');
  appRoot.classList.remove('hidden');
  document.getElementById('chip-name').textContent = user.displayName || user.email;
  document.getElementById('chip-avatar').src = user.photoURL || '';
  loadProfile(user.uid);
});

function loadProfile(uid){
  Promise.all([
    getDoc(doc(db, 'users', uid)),
    // ไม่ใช้ orderBy ร่วมกับ where เพื่อไม่ต้องพึ่ง composite index — เรียงเองฝั่ง client แทน (แบบเดียวกับ src/app.js)
    getDocs(query(collection(db, 'trades'), where('uid', '==', uid), limit(200)))
  ]).then(function(results){
    var userSnap = results[0], tradesSnap = results[1];
    var u = userSnap.exists() ? userSnap.data() : {};

    var trades = [];
    tradesSnap.forEach(function(d){ trades.push(d.data()); });
    trades.sort(function(a,b){ return tsToMs(b.ts) - tsToMs(a.ts); });

    renderSummary(u, trades);
    renderTrades(trades);
  }).catch(function(err){
    console.error('load profile failed', err);
    document.getElementById('trades-sub').textContent = 'โหลดข้อมูลไม่สำเร็จ: ' + err.message;
  });
}

function renderSummary(u, trades){
  var usd = u.usd || {};
  var thb = u.thb || {};
  var usdAuto = usd.autoTrade || {};
  var thbAuto = thb.autoTrade || {};
  var autoTrades = trades.filter(function(t){ return t.autoTrade; });

  function statusText(auto){
    return auto.enabled ? 'เปิดใช้งานอยู่' : 'ปิดอยู่';
  }

  var el = document.getElementById('summary-stats');
  el.innerHTML = [
    ['เงินสด (USD)', fmtCcy(usd.cash, '$')],
    ['BTC ที่ถือ (USD)', (usd.btc||0).toFixed(8)+' BTC'],
    ['เงินสด (THB)', fmtCcy(thb.cash, '฿')],
    ['BTC ที่ถือ (THB)', (thb.btc||0).toFixed(8)+' BTC'],
    ['ออโต้เทรด USD', statusText(usdAuto)],
    ['ออโต้เทรด THB', statusText(thbAuto)],
    ['รอบเทรดครบวง (USD)', (usdAuto.roundTrips||0)+' รอบ · '+((usdAuto.btcAccumulated||0)>=0?'+':'')+(usdAuto.btcAccumulated||0).toFixed(8)+' BTC'],
    ['รอบเทรดครบวง (THB)', (thbAuto.roundTrips||0)+' รอบ · '+((thbAuto.btcAccumulated||0)>=0?'+':'')+(thbAuto.btcAccumulated||0).toFixed(8)+' BTC'],
    ['เทรดโดยออโต้ทั้งหมด', autoTrades.length+' ครั้ง (จาก '+trades.length+' ครั้ง)'],
  ].map(function(row){
    return '<div class="admin-stat"><div class="label">'+esc(row[0])+'</div><div class="value" style="font-size:15px;">'+esc(row[1])+'</div></div>';
  }).join('');
}

function renderTrades(trades){
  document.getElementById('trades-sub').textContent = trades.length + ' รายการล่าสุด';
  var el = document.getElementById('my-trades-list');
  if (!trades.length){
    el.innerHTML = '<div class="history-empty">ยังไม่มีการเทรด — ลองซื้อขายเองหรือเปิดใช้งานออโต้เทรดในหน้าเทรดหลัก</div>';
    return;
  }
  el.innerHTML = trades.map(function(t){
    var sideLabel = t.side==='buy' ? 'ซื้อ' : 'ขาย';
    var pillClass = t.side==='buy' ? 'pill-buy' : 'pill-sell';
    var sym = t.ccy==='thb' ? '฿' : '$';
    var sourceLabel = t.autoTrade ? (SLEEVE_LABELS[t.sleeve] || 'ออโต้เทรด') : t.dca ? 'DCA อัตโนมัติ' : 'สั่งเอง';

    return '<div class="dec-card">' +
      '<div class="dec-head">' +
        '<span class="pill '+pillClass+'">'+esc(sideLabel)+'</span>' +
        '<span class="pill pill-neutral">'+esc(MARKET_LABELS[t.market]||t.market||'')+'</span>' +
        '<span class="pill pill-neutral">'+esc(sourceLabel)+'</span>' +
        '<span class="dec-score">'+fmtCcy(t.price,sym)+' × '+(t.qty||0).toFixed(8)+' BTC = '+fmtCcy(t.usd,sym)+' (ค่าธรรมเนียม '+fmtCcy(t.fee||0,sym)+')</span>' +
        '<span class="dec-time">'+fmtTime(tsToMs(t.ts))+'</span>' +
      '</div>' +
      (t.reason ? '<div class="dec-reason">'+esc(t.reason)+'</div>' : '<div class="dec-reason" style="color:var(--text-faint);">คุณสั่งซื้อขายด้วยตัวเอง</div>') +
    '</div>';
  }).join('');
}
