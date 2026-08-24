import { auth, googleProvider, db, ADMIN_EMAIL } from "./firebase.js";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { collection, getDocs, query, orderBy, limit } from "firebase/firestore";

function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function fmt$(n){ n = n||0; return "$"+n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtCcy(n, sym){ n = n||0; return sym+n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtBaht(n){ return fmtCcy(n, '฿'); }
var STARTING = { usd:10000, thb:100000 };
function tsToMs(ts){ return ts && ts.toMillis ? ts.toMillis() : 0; }
function fmtTime(ms){ return ms ? new Date(ms).toLocaleString(undefined,{dateStyle:'short',timeStyle:'medium'}) : '—'; }

document.getElementById('btn-google').addEventListener('click', function(){
  var errEl = document.getElementById('login-error');
  errEl.textContent = '';
  signInWithPopup(auth, googleProvider).catch(function(err){
    errEl.textContent = 'เข้าสู่ระบบไม่สำเร็จ: ' + (err && err.message ? err.message : 'unknown error');
  });
});
document.getElementById('btn-logout').addEventListener('click', function(){ signOut(auth); });
document.getElementById('btn-logout-denied').addEventListener('click', function(){ signOut(auth); });

onAuthStateChanged(auth, function(user){
  var loginOverlay = document.getElementById('login-overlay');
  var deniedRoot = document.getElementById('denied-root');
  var appRoot = document.getElementById('app-root');

  if (!user){
    loginOverlay.classList.remove('hidden');
    deniedRoot.classList.add('hidden');
    appRoot.classList.add('hidden');
    return;
  }
  if (user.email !== ADMIN_EMAIL){
    loginOverlay.classList.add('hidden');
    appRoot.classList.add('hidden');
    deniedRoot.classList.remove('hidden');
    return;
  }
  loginOverlay.classList.add('hidden');
  deniedRoot.classList.add('hidden');
  appRoot.classList.remove('hidden');
  document.getElementById('chip-name').textContent = user.displayName || user.email;
  document.getElementById('chip-avatar').src = user.photoURL || '';
  loadDashboard();
});

function loadDashboard(){
  Promise.all([
    getDocs(collection(db, 'users')),
    getDocs(query(collection(db, 'trades'), orderBy('ts','desc'), limit(100))),
    getDocs(query(collection(db, 'logs'), orderBy('ts','desc'), limit(150)))
  ]).then(function(results){
    var usersSnap = results[0], tradesSnap = results[1], logsSnap = results[2];

    var users = [];
    usersSnap.forEach(function(d){ users.push(Object.assign({ uid: d.id }, d.data())); });
    // no live market price on the admin page, so equity is approximated at cost basis (cash + btc*avgEntry)
    // บัญชีเก่าก่อนแยก usd/thb จะยังไม่มี .usd — จับคู่ให้จากฟิลด์เดิมเพื่อไม่ให้หน้านี้พัง
    users.forEach(function(u){
      if (!u.usd) u.usd = { cash: u.cash||0, btc: u.btc||0, avgEntry: u.avgEntry||0 };
      if (!u.thb) u.thb = { cash: 0, btc: 0, avgEntry: 0 };
      u.usd.equityApprox = (u.usd.cash||0) + (u.usd.btc||0)*(u.usd.avgEntry||0);
      u.thb.equityApprox = (u.thb.cash||0) + (u.thb.btc||0)*(u.thb.avgEntry||0);
    });
    users.sort(function(a,b){ return b.usd.equityApprox - a.usd.equityApprox; });

    var trades = [];
    tradesSnap.forEach(function(d){ trades.push(d.data()); });

    var logs = [];
    logsSnap.forEach(function(d){ logs.push(d.data()); });

    renderStats(users, trades, logs);
    renderUsersTable(users);
    renderTradesTable(trades);
    renderLogsTable(logs);
  }).catch(function(err){
    console.error('admin load failed', err);
    document.getElementById('users-sub').textContent = 'โหลดข้อมูลไม่สำเร็จ: ' + err.message;
  });
}

function renderStats(users, trades, logs){
  document.getElementById('stat-users').textContent = users.length;
  document.getElementById('stat-trades').textContent = trades.length + (trades.length>=100 ? '+' : '');
  var buys = trades.filter(function(t){ return t.side==='buy'; }).length;
  var sells = trades.filter(function(t){ return t.side==='sell'; }).length;
  document.getElementById('stat-ratio').textContent = buys + ' / ' + sells;
  var usdTrades = trades.filter(function(t){ return (t.ccy||'usd')==='usd'; });
  var thbTrades = trades.filter(function(t){ return t.ccy==='thb'; });
  var volUsd = usdTrades.reduce(function(a,t){ return a + (t.usd||0); }, 0);
  var volThb = thbTrades.reduce(function(a,t){ return a + (t.usd||0); }, 0);
  document.getElementById('stat-volume').textContent = fmt$(volUsd) + ' / ' + fmtBaht(volThb);
  var feeUsd = usdTrades.reduce(function(a,t){ return a + (t.fee||0); }, 0);
  var feeThb = thbTrades.reduce(function(a,t){ return a + (t.fee||0); }, 0);
  document.getElementById('stat-fees').textContent = fmt$(feeUsd) + ' / ' + fmtBaht(feeThb);
  document.getElementById('stat-logs').textContent = logs.length + (logs.length>=150 ? '+' : '');
}

function renderUsersTable(users){
  document.getElementById('users-sub').textContent = users.length + ' บัญชี';
  var tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = users.map(function(u){
    var retUsd = ((u.usd.equityApprox-STARTING.usd)/STARTING.usd*100).toFixed(2);
    var retThb = ((u.thb.equityApprox-STARTING.thb)/STARTING.thb*100).toFixed(2);
    return '<tr><td>'+esc(u.email||u.uid)+'</td>' +
      '<td>'+fmt$(u.usd.cash)+'</td><td>'+(u.usd.btc||0).toFixed(5)+'</td><td>'+fmt$(u.usd.equityApprox)+'</td>' +
      '<td style="color:'+(retUsd>=0?'var(--up)':'var(--down)')+'">'+(retUsd>=0?'+':'')+retUsd+'%</td>' +
      '<td>'+fmtBaht(u.thb.cash)+'</td><td>'+(u.thb.btc||0).toFixed(5)+'</td><td>'+fmtBaht(u.thb.equityApprox)+'</td>' +
      '<td style="color:'+(retThb>=0?'var(--up)':'var(--down)')+'">'+(retThb>=0?'+':'')+retThb+'%</td>' +
      '<td>'+fmtTime(tsToMs(u.createdAt))+'</td></tr>';
  }).join('') || '<tr><td colspan="10" style="text-align:center;color:var(--text-faint);">ยังไม่มีผู้ใช้</td></tr>';
}

var MARKET_LABELS = { binance: 'Binance', bitkub: 'Bitkub' };

function renderTradesTable(trades){
  var tbody = document.querySelector('#trades-table tbody');
  tbody.innerHTML = trades.map(function(t){
    var pillClass = t.side==='buy' ? 'pill-buy' : 'pill-sell';
    var sideLabel = t.side==='buy' ? 'ซื้อ' : 'ขาย';
    var sym = t.ccy==='thb' ? '฿' : '$';
    var marketLabel = MARKET_LABELS[t.market] || 'Binance';
    return '<tr><td>'+fmtTime(tsToMs(t.ts))+'</td><td>'+esc(t.email)+'</td>' +
      '<td><span class="pill pill-neutral">'+esc(marketLabel)+'</span></td>' +
      '<td><span class="pill '+pillClass+'">'+esc(sideLabel)+'</span></td>' +
      '<td>'+fmtCcy(t.price,sym)+'</td><td>'+(t.qty||0).toFixed(5)+'</td><td>'+fmtCcy(t.usd,sym)+'</td><td>'+fmtCcy(t.fee||0,sym)+'</td><td>'+fmtCcy(t.equityAfter,sym)+'</td></tr>';
  }).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--text-faint);">ยังไม่มีคำสั่งซื้อขาย</td></tr>';
}

var LOG_LABELS = {
  signup: 'สมัคร', login: 'เข้าสู่ระบบ', logout: 'ออกจากระบบ',
  trade: 'เทรด', insufficient_funds: 'เงินไม่พอ', reset_account: 'รีเซตบัญชี', topup: 'เติมเงิน',
  order_created: 'ตั้งคำสั่งรอราคา', order_cancelled: 'ยกเลิกคำสั่งรอราคา', order_triggered: 'คำสั่งรอราคาทำงาน',
  disclaimer_acknowledged: 'ยอมรับคำชี้แจง'
};

function renderLogsTable(logs){
  var tbody = document.querySelector('#logs-table tbody');
  tbody.innerHTML = logs.map(function(l){
    var label = LOG_LABELS[l.type] || l.type;
    var pillClass = l.type==='trade' ? 'pill-buy' : (l.type==='insufficient_funds' ? 'pill-sell' : 'pill-neutral');
    var detail = '';
    try { detail = Object.keys(l.detail||{}).map(function(k){ return k+'='+l.detail[k]; }).join(', '); } catch(e){}
    return '<tr><td>'+fmtTime(tsToMs(l.ts))+'</td><td>'+esc(l.email)+'</td>' +
      '<td><span class="pill '+pillClass+'">'+esc(label)+'</span></td><td>'+esc(detail)+'</td></tr>';
  }).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--text-faint);">ยังไม่มีกิจกรรม</td></tr>';
}
