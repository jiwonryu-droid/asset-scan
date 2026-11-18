/* 전산비품 실사 — 오프라인 모바일 앱
 * 원장(엑셀) → 폰 저장(IndexedDB) → 입고/출고/실사 스캔 → 결과 엑셀 → PC 업로드
 */
const APP_VERSION = "1.0.0";

/* ============================================================ 공통 유틸 */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const nowStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const normNo = (s) => String(s ?? "").trim().toUpperCase();
const store = {
  get(k, d = "") { try { return localStorage.getItem("asset." + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("asset." + k, v); } catch {} },
};
function toast(msg, kind = "ok", ms = 2200) {
  let box = $("#toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; document.body.appendChild(box); }
  const t = document.createElement("div"); t.className = `toast ${kind}`; t.textContent = msg; box.appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, ms);
}
const Worker = {
  get: () => store.get("worker"),
  set: (v) => store.set("worker", v.trim()),
  ensure() { let w = this.get(); if (!w) { w = (prompt("작업자 이름을 입력하세요 (기록에 남습니다)") || "").trim(); if (w) this.set(w); } return w; },
};
const STATUS_CLASS = { 사용중: "s-use", 재고: "s-stock", 예비장비: "s-stock", 수리의뢰: "s-repair", 폐기대상: "s-dispose", 폐기: "s-dead", 분실: "s-dead" };
const TYPE_CLASS = { 입고: "t-in", 출고: "t-out", 실사: "t-audit", 등록: "t-reg" };
const statusBadge = (s) => `<span class="badge ${STATUS_CLASS[s] || ""}">${esc(s || "-")}</span>`;
const typeBadge = (t) => `<span class="badge ${TYPE_CLASS[t] || ""}">${esc(t)}</span>`;
const opts = (arr, sel = "", blank = null) => (blank !== null ? `<option value="">${esc(blank)}</option>` : "") +
  arr.map((v) => `<option ${v === sel ? "selected" : ""}>${esc(v)}</option>`).join("");
let _actx;
function beep(ok = true) {
  try {
    if (navigator.vibrate) navigator.vibrate(ok ? 80 : [60, 60, 60]);
    _actx = _actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = _actx.createOscillator(), g = _actx.createGain();
    o.frequency.value = ok ? 1800 : 400; o.type = "square"; g.gain.value = 0.05;
    o.connect(g); g.connect(_actx.destination); o.start(); o.stop(_actx.currentTime + (ok ? 0.08 : 0.25));
  } catch {}
}

const LISTS = {
  categories: ["노트북", "데스크탑", "모니터", "프린터", "태블릿", "기타"],
  sites: ["평택", "용인(본사)", "용인(연구소)", "기타"],
  in_reasons: ["퇴사회수", "교체회수", "신규구매", "수리완료", "반납", "기타"],
  out_reasons: ["신규지급", "교체지급", "대여", "수리출고", "폐기출고", "기타"],
};

/* ============================================================ 폰 저장소 (IndexedDB) */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("asset-offline", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("assets", { keyPath: "asset_no" });
        d.createObjectStore("records", { keyPath: "id" });
        d.createObjectStore("meta");
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  run(name, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(name, mode), s = t.objectStore(name);
      const req = fn(s);
      t.oncomplete = () => res(req && "result" in req ? req.result : undefined);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  all: (n) => DB.run(n, "readonly", (s) => s.getAll()),
  put: (n, v, k) => DB.run(n, "readwrite", (s) => (k === undefined ? s.put(v) : s.put(v, k))),
  get: (n, k) => DB.run(n, "readonly", (s) => s.get(k)),
  del: (n, k) => DB.run(n, "readwrite", (s) => s.delete(k)),
  clear: (n) => DB.run(n, "readwrite", (s) => s.clear()),
  bulkReplace(n, list) {
    return DB.run(n, "readwrite", (s) => { s.clear(); list.forEach((v) => s.put(v)); });
  },
};

/* 메모리 상태 */
const S = { assets: new Map(), records: [], meta: {}, mode: "", session: [], audit: null, busy: false };
async function loadAll() {
  const [assets, records, ledger, audit, lastExport] = await Promise.all([
    DB.all("assets"), DB.all("records"), DB.get("meta", "ledger"), DB.get("meta", "audit"), DB.get("meta", "lastExport")]);
  S.assets = new Map(assets.map((a) => [a.asset_no, a]));
  S.records = records.sort((a, b) => (a.at < b.at ? -1 : 1));
  S.meta = { ledger, lastExport }; S.audit = audit || null;
}
async function addRecord(r) {
  const rec = { id: uid(), at: nowStr(), worker: Worker.get(), device: "모바일", sent: 0, ...r };
  await DB.put("records", rec); S.records.push(rec); return rec;
}
async function saveAsset(a) { await DB.put("assets", a); S.assets.set(a.asset_no, a); }
const pending = () => S.records.filter((r) => !r.sent);
const userLabel = (a) => { const who = [a.user_empno, a.user_name].filter(Boolean).join(" "); return a.dept ? `${who} | ${a.dept}` : who; };

/* ============================================================ 원장 불러오기 (엑셀) */
const ALIASES = {
  asset_no: ["관리번호", "자산번호", "비품번호", "바코드"], name: ["명칭", "품명", "자산명", "비품명"],
  category: ["장비구분", "구분", "분류", "자산구분"], status: ["비품상태", "상태", "자산상태"], corp: ["법인"],
  site: ["공장", "사업장"], dept_code: ["부서", "부서코드"], dept: ["부서명"], user_empno: ["사용자", "사번", "사용자사번"],
  user_name: ["사용자명", "성명", "이름"], location: ["보관위치", "설치위치", "위치"], model: ["모델명", "모델"],
  serial_no: ["시리얼번호", "시리얼", "S/N", "SN"], note: ["비고", "메모"],
};
function parseLedger(buf) {
  const wb = XLSX.read(buf, { type: "array", cellDates: false });
  for (const sn of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: "" });
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const hdr = rows[i].map((v) => String(v).trim());
      if (!hdr.some((h) => ALIASES.asset_no.includes(h))) continue;
      const col = {}, used = new Set();
      for (const [f, al] of Object.entries(ALIASES)) {
        const idx = hdr.findIndex((h, j) => al.includes(h) && !used.has(j));
        if (idx >= 0) { col[f] = idx; used.add(idx); }
      }
      const out = new Map();
      for (const r of rows.slice(i + 1)) {
        const no = normNo(r[col.asset_no]);
        if (!no) continue;
        const a = { asset_no: no };
        for (const [f, j] of Object.entries(col)) if (f !== "asset_no") a[f] = String(r[j] ?? "").trim();
        a.status = a.status || "재고";
        out.set(no, a);
      }
      return { sheet: sn, assets: [...out.values()], cols: Object.keys(col).length };
    }
  }
  throw new Error("'관리번호' 컬럼이 있는 시트를 찾지 못했습니다.");
}
$("#fileLedger").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const r = parseLedger(new Uint8Array(await f.arrayBuffer()));
    if (!r.assets.length) throw new Error("비품 행이 없습니다.");
    if (S.assets.size && !confirm(`현재 원장 ${S.assets.size}건을 새 원장 ${r.assets.length}건으로 바꿉니다.\n(스캔 기록은 그대로 유지됩니다)`)) return;
    await DB.bulkReplace("assets", r.assets);
    const ledger = { file: f.name, at: nowStr(), count: r.assets.length };
    await DB.put("meta", ledger, "ledger");
    S.assets = new Map(r.assets.map((a) => [a.asset_no, a])); S.meta.ledger = ledger;
    toast(`원장 ${r.assets.length}건을 불러왔습니다.`); renderHome();
  } catch (err) { toast(err.message, "err", 4000); }
};
$("#btnLoad").onclick = () => $("#fileLedger").click();

/* ============================================================ 결과 내보내기 (엑셀 → 공유) */
const EXPORT_COLS = [["id", "기록ID"], ["at", "일시"], ["type", "구분"], ["asset_no", "관리번호"], ["asset_name", "명칭"],
  ["reason", "사유"], ["worker", "작업자"], ["from_user", "이전사용자"], ["user_empno", "사용자사번"], ["user_name", "사용자명"],
  ["dept", "부서"], ["site", "공장"], ["location", "위치"], ["note", "비고"], ["audit_name", "실사명"], ["audit_site", "실사범위"],
  ["result", "실사결과"], ["category", "장비구분"], ["model", "모델명"], ["serial_no", "시리얼번호"], ["device", "기기"]];

async function exportRecords(all = false) {
  const list = all ? S.records : pending();
  if (!list.length) return toast("보낼 기록이 없습니다.", "warn");
  const aoa = [EXPORT_COLS.map(([, h]) => h), ...list.map((r) => EXPORT_COLS.map(([k]) => r[k] ?? ""))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = EXPORT_COLS.map(([k]) => ({ wch: { id: 10, at: 19, asset_no: 14, asset_name: 22, from_user: 20, note: 24 }[k] || 11 }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "모바일기록");
  const d = new Date();
  const name = `비품실사결과_${Worker.get() || "작업자"}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.xlsx`;
  const blob = new Blob([XLSX.write(wb, { type: "array", bookType: "xlsx" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const file = new File([blob], name, { type: blob.type });
  let delivered = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "전산비품 실사 결과", text: `${list.length}건 (${Worker.get()})` }); delivered = true; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  if (!delivered) {   // 공유 미지원 → 파일 저장
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  if (!all && confirm(`${list.length}건을 PC로 보냈나요?\n'확인'을 누르면 보낸 기록으로 표시합니다.`)) {
    const t = nowStr();
    for (const r of list) { r.sent = 1; r.sent_at = t; await DB.put("records", r); }
    S.meta.lastExport = t; await DB.put("meta", t, "lastExport");
  }
  renderHome();
}
$("#btnExport").onclick = () => exportRecords(false);

/* ============================================================ 카메라 */
class Cam {
  constructor(elId, btnId, onCode) {
    this.elId = elId; this.btn = $("#" + btnId); this.onCode = onCode; this.h = null; this.paused = false; this.last = ""; this.lastAt = 0;
    this.btn.onclick = () => (this.h ? this.stop(true) : this.start());
  }
  msg(html) { $("#" + this.elId).innerHTML = `<div class="reader-msg">${html}</div>`; }
  async start() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.msg("이 주소에서는 카메라를 쓸 수 없습니다 (HTTPS 필요).<br>아래 입력칸이나 블루투스 스캐너를 사용하세요."); this.btn.hidden = true; return;
    }
    if (this.h) return;
    this.btn.hidden = false; this.btn.textContent = "카메라 끄기"; $("#" + this.elId).innerHTML = "";
    const F = Html5QrcodeSupportedFormats;
    this.h = new Html5Qrcode(this.elId, {
      verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      formatsToSupport: [F.CODE_128, F.CODE_39, F.CODE_93, F.QR_CODE, F.DATA_MATRIX, F.EAN_13, F.EAN_8, F.ITF, F.CODABAR, F.UPC_A],
    });
    try {
      await this.h.start({ facingMode: "environment" },
        { fps: 12, qrbox: (w, h) => ({ width: Math.floor(w * 0.88), height: Math.max(90, Math.floor(Math.min(w, h) * 0.45)) }) },
        (t) => this.hit(t), () => {});
      this.paused = false;
    } catch (e) {
      this.h = null; this.btn.textContent = "다시 시도";
      this.msg(`카메라를 열 수 없습니다.<br><small>${esc(e?.message || e)}</small><br><br>설정에서 카메라 권한을 허용하세요.`);
    }
  }
  hit(t) {
    if (this.paused) return;
    const n = Date.now(); if (t === this.last && n - this.lastAt < 2500) return;
    this.last = t; this.lastAt = n; this.onCode(t);
  }
  pause() { this.paused = true; try { this.h?.pause(true); } catch {} }
  resume() { this.paused = false; this.last = ""; try { this.h?.resume(); } catch {} }
  async stop(byUser = false) {
    if (this.h) { try { await this.h.stop(); } catch {} try { this.h.clear(); } catch {} this.h = null; }
    if (byUser) { this.msg("카메라가 꺼져 있습니다."); this.btn.textContent = "카메라 켜기"; }
  }
}
const cam = new Cam("reader", "btnCam", (c) => onScan(c));
const cam2 = new Cam("reader2", "btnCam2", (c) => onAuditScan(c));

/* 블루투스/PDA 스캐너 (키보드 입력) */
let kbBuf = "", kbAt = 0;
document.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  const v = $(".view.on")?.id;
  if (!(v === "v-scan" || (v === "v-audit" && !$("#auditRun").hidden)) || $("#sheet").classList.contains("on")) return;
  const t = Date.now(); if (t - kbAt > 300) kbBuf = ""; kbAt = t;
  if (e.key === "Enter") { if (kbBuf.length >= 3) { (v === "v-scan" ? onScan : onAuditScan)(kbBuf); e.preventDefault(); } kbBuf = ""; }
  else if (e.key.length === 1) kbBuf += e.key;
});

/* ============================================================ 화면 전환 */
function show(id, title, back = true) {
  $$(".view").forEach((v) => v.classList.toggle("on", v.id === id));
  $("#title").textContent = title; $("#btnBack").hidden = !back; window.scrollTo(0, 0);
}
async function goHome() {
  closeSheet(false); S.mode = "";
  await Promise.all([cam.stop(), cam2.stop()]);
  show("v-home", "전산비품 실사", false); renderHome();
}
function go(mode) {
  if (!Worker.ensure()) return; renderWorker();
  history.pushState({ v: mode }, "");
  if (mode === "실사") return openAudit();
  if (mode === "관리") return openMenu();
  S.mode = mode; S.session = [];
  show("v-scan", { 입고: "입고 스캔", 출고: "출고 스캔", 조회: "비품 조회" }[mode]); renderSession(); cam.start();
}
$("#btnBack").onclick = () => history.back();
window.addEventListener("popstate", () => {
  if ($("#sheet").classList.contains("on")) { closeSheet(); history.pushState({ v: "keep" }, ""); return; }
  goHome();
});
$$("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));
$("#btnMenu").onclick = () => go("관리");
function renderWorker() { $("#btnWorker").textContent = "👤 " + (Worker.get() || "작업자 설정"); }
$("#btnWorker").onclick = () => { const v = prompt("작업자 이름", Worker.get()); if (v && v.trim()) { Worker.set(v); renderWorker(); } };

/* ============================================================ 홈 */
function auditStats() {
  const au = S.audit; if (!au) return null;
  let target = 0;
  for (const a of S.assets.values()) if (!["폐기", "분실"].includes(a.status) && (!au.site || a.site === au.site)) target++;
  const scans = S.records.filter((r) => r.type === "실사" && r.audit_id === au.id);
  const c = (k) => scans.filter((s) => s.result === k).length;
  const found = c("정상");
  return { target, found, missing: Math.max(0, target - found), 범위외: c("범위외"), 미등록: c("미등록"), scans };
}
function renderHome() {
  $("#cntAssets").textContent = S.assets.size.toLocaleString();
  $("#ledgerInfo").textContent = S.meta.ledger ? `${S.meta.ledger.at.slice(5, 16)} · ${S.meta.ledger.file}` : "불러온 원장 없음";
  const p = pending().length;
  $("#cntPending").textContent = p; $("#cntPending").classList.toggle("pending", p > 0);
  $("#lastExport").textContent = S.meta.lastExport ? `마지막 전송 ${S.meta.lastExport.slice(5, 16)}` : " ";
  const notes = [];
  const ios = /iphone|ipad/i.test(navigator.userAgent), standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (!standalone) notes.push(`<div class="notice info"><b>홈 화면에 추가</b>해서 사용하세요. ${ios ? "Safari 하단 공유 버튼 → '홈 화면에 추가'" : "Chrome 메뉴(⋮) → '홈 화면에 추가' 또는 '앱 설치'"}<br><small>${ios ? "추가하지 않으면 오래 안 쓸 때 폰이 저장 기록을 지울 수 있습니다." : "인터넷 없이도 앱처럼 실행됩니다."}</small></div>`);
  if (!S.assets.size) notes.push(`<div class="notice">원장이 없습니다. PC에서 받은 <b>비품원장 엑셀</b>을 [원장 불러오기]로 선택하세요. 원장 없이도 스캔은 가능합니다(미등록으로 기록).</div>`);
  if (p >= 1 && S.meta.lastExport && Date.now() - new Date(S.meta.lastExport.replace(" ", "T")) > 3 * 864e5) notes.push(`<div class="notice">보내지 않은 기록이 ${p}건 있습니다. [결과 보내기]로 PC에 전달하세요.</div>`);
  $("#notices").innerHTML = notes.join("");
  const ac = $("#auditCard"), st = auditStats();
  if (st) {
    const pct = st.target ? Math.round((st.found / st.target) * 100) : 0;
    ac.hidden = false;
    ac.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><b>진행중 실사 · ${esc(S.audit.name)}</b>
      <span class="badge t-audit">${esc(S.audit.site || "전체")}</span></div><div class="progress"><div style="width:${pct}%"></div></div>
      <div class="stat-row"><span>확인 ${st.found} / ${st.target} · 미확인 ${st.missing}</span><span>${pct}%</span></div>`;
    ac.onclick = () => go("실사");
  } else ac.hidden = true;
  const rec = S.records.slice(-10).reverse();
  $("#recent").innerHTML = rec.length ? rec.map((r) => `<li>${typeBadge(r.type)}<div class="main">
      <div><b>${esc(r.asset_no)}</b> ${esc(r.asset_name || "")}</div>
      <small>${esc(r.type === "출고" ? userLabel(r) : r.type === "실사" ? r.result : r.from_user || r.reason || "")}${r.sent ? " · 전송됨" : ""}</small></div>
      <small>${esc(r.at.slice(5, 16))}</small></li>`).join("") : `<li class="muted">기록이 없습니다.</li>`;
}

/* ============================================================ 결과 시트 */
function openSheet(html) { $("#sheetBody").innerHTML = html; $("#sheet").classList.add("on"); $("#sheetBg").classList.add("on"); $("#sheet").scrollTop = 0; }
function closeSheet(resume = true) {
  if (!$("#sheet").classList.contains("on")) return;
  $("#sheet").classList.remove("on"); $("#sheetBg").classList.remove("on");
  if (resume) ($(".view.on").id === "v-audit" ? cam2 : cam).resume();
}
$("#sheetBg").onclick = () => closeSheet();
function assetCard(a) {
  const rows = [["장비구분", a.category], ["공장", a.site], ["부서", a.dept], ["사용자", [a.user_empno, a.user_name].filter(Boolean).join(" ")],
    ["위치", a.location], ["모델", a.model], ["시리얼", a.serial_no], ["비고", a.note]].filter(([, v]) => v);
  return `<div class="asset-head"><div><div class="asset-no">${esc(a.asset_no)}</div><div class="asset-name">${esc(a.name || "(명칭 없음)")}</div></div>${statusBadge(a.status)}</div>
    <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
}

/* ============================================================ 입고 / 출고 / 조회 */
$("#manualForm").onsubmit = (e) => { e.preventDefault(); const v = $("#manualInput").value; $("#manualInput").value = ""; $("#manualInput").blur(); if (v.trim()) onScan(v); };
function onScan(raw) {
  const code = normNo(raw); if (!code || S.busy) return;
  cam.pause();
  const a = S.assets.get(code);
  if (!a) { beep(false); return sheetNotFound(code); }
  beep(true);
  S.mode === "조회" ? sheetLookup(a) : sheetTx(a);
}
function sheetNotFound(code) {
  const canReg = S.mode !== "조회";
  openSheet(`<div class="notfound">원장에 없는 관리번호입니다<br><span style="font-size:20px">${esc(code)}</span></div>
    <p class="muted" style="font-size:14px">${canReg ? "신규 비품이면 등록한 뒤 이어서 처리하세요. 등록 내용도 PC로 전송됩니다." : "원장이 최신인지 확인하세요."}</p>
    <div class="actions"><button class="btn" id="shCancel">닫기</button>${canReg ? `<button class="btn primary" id="shReg">신규 등록</button>` : ""}</div>`);
  $("#shCancel").onclick = () => closeSheet();
  if (canReg) $("#shReg").onclick = () => sheetRegister(code);
}
function sheetRegister(code) {
  openSheet(`<h3 style="margin:4px 0 10px">신규 비품 등록</h3>
    <form class="form" id="regForm">
      <label class="f">관리번호<input value="${esc(code)}" disabled></label>
      <label class="f req">명칭<input name="name" required placeholder="예: LG 그램 15Z90S"></label>
      <div class="row"><label class="f">장비구분<select name="category">${opts(LISTS.categories, "노트북")}</select></label>
        <label class="f">공장<select name="site">${opts(LISTS.sites, store.get("site"), "-")}</select></label></div>
      <div class="row"><label class="f">모델명<input name="model"></label><label class="f">시리얼번호<input name="serial_no"></label></div>
      <label class="f">비고<input name="note"></label>
      <div class="actions"><button type="button" class="btn" id="shCancel">취소</button><button class="btn primary">등록</button></div>
    </form>`);
  $("#shCancel").onclick = () => closeSheet();
  $("#regForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const a = { asset_no: code, status: "재고", ...f };
    await saveAsset(a);
    await addRecord({ type: "등록", asset_no: code, asset_name: f.name, category: f.category, site: f.site, model: f.model, serial_no: f.serial_no, note: f.note });
    toast(`${code} 등록`); sheetTx(a);
  };
}
function sheetTx(a) {
  const isIn = S.mode === "입고";
  const warn = isIn ? (a.status === "재고" ? `<div class="banner on 범위외">이미 재고 상태입니다.</div>` : "")
    : (a.status === "사용중" && a.user_name ? `<div class="banner on 범위외">현재 사용자 <b>${esc(a.user_name)}</b>${a.dept ? " (" + esc(a.dept) + ")" : ""} → 출고하면 변경됩니다.</div>` : "");
  const depts = [...new Set([...S.assets.values()].map((x) => x.dept).filter(Boolean))].sort();
  const form = isIn ? `
      <label class="f">입고 사유<select name="reason">${opts(LISTS.in_reasons, store.get("in_reason", "퇴사회수"))}</select></label>
      <div class="row"><label class="f">공장<select name="site">${opts(LISTS.sites, a.site || store.get("site"), "-")}</select></label>
        <label class="f">보관위치<input name="location" value="${esc(store.get("in_loc", a.location || ""))}" placeholder="예: 정보팀 창고"></label></div>` : `
      <div class="row"><label class="f req">사용자명<input name="user_name" required></label><label class="f">사번<input name="user_empno" inputmode="numeric"></label></div>
      <label class="f">부서<input name="dept" list="deptList"></label><datalist id="deptList">${depts.map((d) => `<option value="${esc(d)}">`).join("")}</datalist>
      <div class="row"><label class="f">출고 사유<select name="reason">${opts(LISTS.out_reasons, store.get("out_reason", "신규지급"))}</select></label>
        <label class="f">공장<select name="site">${opts(LISTS.sites, a.site || store.get("site"), "-")}</select></label></div>
      <label class="f">설치위치<input name="location" placeholder="예: 2층 개발실"></label>`;
  openSheet(`${assetCard(a)}${warn}<form class="form" id="txForm">${form}<label class="f">비고<input name="note"></label>
    <div class="actions"><button type="button" class="btn" id="shCancel">취소</button><button class="btn ${isIn ? "in" : "out"}">${S.mode} 처리</button></div></form>`);
  $("#shCancel").onclick = () => closeSheet();
  $("#txForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const from = userLabel(a), site = f.site || a.site || "";
    const rec = { type: S.mode, asset_no: a.asset_no, asset_name: a.name, reason: f.reason, from_user: from, site, location: f.location || "", note: f.note };
    if (isIn) {
      Object.assign(a, { status: "재고", user_empno: "", user_name: "", dept: "", dept_code: "", site, location: f.location || a.location || "" });
      store.set("in_reason", f.reason); store.set("in_loc", f.location || "");
    } else {
      Object.assign(rec, { user_empno: f.user_empno, user_name: f.user_name, dept: f.dept });
      Object.assign(a, { status: "사용중", user_empno: f.user_empno, user_name: f.user_name, dept: f.dept, site, location: f.location || "" });
      store.set("out_reason", f.reason);
    }
    if (f.site) store.set("site", f.site);
    await saveAsset(a); await addRecord(rec);
    S.session.unshift({ ...a, t: nowStr().slice(11, 16), who: isIn ? from : f.user_name });
    renderSession(); toast(`${a.asset_no} ${S.mode} 완료`); closeSheet();
  };
}
function sheetLookup(a) {
  const hist = S.records.filter((r) => r.asset_no === a.asset_no).slice(-12).reverse();
  openSheet(`${assetCard(a)}<h3 style="font-size:15px;margin:6px 0">이 폰의 기록</h3>
    <ul class="list">${hist.length ? hist.map((h) => `<li>${typeBadge(h.type)}<div class="main"><div>${esc(h.type === "출고" ? userLabel(h) : h.result || h.from_user || h.reason || "")}</div>
      <small>${esc(h.worker)}${h.sent ? " · 전송됨" : ""}</small></div><small>${esc(h.at.slice(2, 16))}</small></li>`).join("") : `<li class="muted">기록 없음</li>`}</ul>
    <div class="actions"><button class="btn primary" id="shCancel">다음 스캔</button></div>`);
  $("#shCancel").onclick = () => closeSheet();
}
function renderSession() {
  const c = $("#sessionCard");
  if (S.mode === "조회" || !S.session.length) { c.hidden = true; return; }
  c.hidden = false; $("#sessionTitle").textContent = `이번 ${S.mode} ${S.session.length}건`;
  $("#sessionList").innerHTML = S.session.map((r) => `<li>${statusBadge(r.status)}<div class="main"><div><b>${esc(r.asset_no)}</b> ${esc(r.name || "")}</div>
    <small>${esc(r.who || "")}</small></div><small>${r.t}</small></li>`).join("");
}

/* ============================================================ 실사 */
function openAudit() {
  S.mode = "실사"; show("v-audit", "실사");
  if (S.audit) return runAudit();
  $("#auditRun").hidden = true; $("#auditPick").hidden = false;
  const d = new Date();
  $("#auditPick").innerHTML = `<div class="card" style="margin-top:0"><h2>새 실사 시작</h2>
    <form class="form" id="newAudit">
      <label class="f req">실사명<input name="name" value="${d.getFullYear()}-${pad(d.getMonth() + 1)} 정기실사" required></label>
      <label class="f">대상 공장<select name="site">${opts(LISTS.sites, "", "전체")}</select></label>
      <p class="hint">PC에서 같은 실사명으로 결과가 합쳐집니다. 여러 명이 나눠 스캔할 때는 실사명을 똑같이 입력하세요.</p>
      <div class="actions"><button class="btn primary" style="background:#7b3fb5;border-color:#7b3fb5">실사 시작</button></div>
    </form></div>`;
  $("#newAudit").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    S.audit = { id: uid(), name: f.name.trim(), site: f.site, started_at: nowStr() };
    await DB.put("meta", S.audit, "audit"); runAudit();
  };
}
function renderAuditSummary() {
  const st = auditStats(), pct = st.target ? Math.round((st.found / st.target) * 100) : 0;
  $("#auName").textContent = S.audit.name; $("#auSite").textContent = S.audit.site || "전체";
  $("#auBar").style.width = pct + "%"; $("#auPct").textContent = pct + "%";
  $("#auStat").textContent = `확인 ${st.found} / ${st.target} · 미확인 ${st.missing}` + (st.범위외 ? ` · 범위외 ${st.범위외}` : "") + (st.미등록 ? ` · 미등록 ${st.미등록}` : "");
  return st;
}
const scanLi = (s) => { const a = S.assets.get(s.asset_no) || {};
  return `<li data-id="${s.id}"><span class="badge r-${esc(s.result)}">${esc(s.result)}</span><div class="main"><div><b>${esc(s.asset_no)}</b> ${esc(a.name || "")}</div>
    <small>${esc([a.dept, a.user_name].filter(Boolean).join(" · ") || s.location || "")}${s.sent ? " · 전송됨" : ""}</small></div>
    <small>${s.at.slice(11, 16)}</small>${s.sent ? "" : `<button class="x" title="스캔 취소">×</button>`}</li>`; };
function runAudit() {
  $("#auditPick").hidden = true; $("#auditRun").hidden = false; $("#auBanner").className = "banner";
  $("#auLoc").value = store.get("au_loc"); $("#title").textContent = "실사 스캔";
  const st = renderAuditSummary();
  $("#auScans").innerHTML = st.scans.slice().reverse().slice(0, 100).map(scanLi).join("") || `<li class="muted">아직 스캔한 비품이 없습니다.</li>`;
  cam2.start();
}
$("#auLoc").onchange = () => store.set("au_loc", $("#auLoc").value.trim());
$("#manualForm2").onsubmit = (e) => { e.preventDefault(); const v = $("#manualInput2").value; $("#manualInput2").value = ""; $("#manualInput2").blur(); if (v.trim()) onAuditScan(v); };
async function onAuditScan(raw) {
  const code = normNo(raw); if (!code || !S.audit || S.busy) return;
  S.busy = true;
  try {
    const a = S.assets.get(code);
    const dup = S.records.find((r) => r.type === "실사" && r.audit_id === S.audit.id && r.asset_no === code);
    const b = $("#auBanner");
    if (dup) {
      b.className = "banner on 중복"; b.innerHTML = `이미 스캔됨 (${dup.at.slice(11, 16)}) · ${esc(dup.result)} — ${esc(code)}<small>${esc(a?.name || "")}</small>`;
      beep(false); return;
    }
    const result = !a ? "미등록" : S.audit.site && a.site !== S.audit.site ? "범위외" : "정상";
    const rec = await addRecord({ type: "실사", asset_no: code, asset_name: a?.name || "", audit_id: S.audit.id, audit_name: S.audit.name,
      audit_site: S.audit.site, result, location: $("#auLoc").value.trim(), site: a?.site || "" });
    b.className = `banner on ${result}`;
    b.innerHTML = `${{ 정상: "확인 완료", 범위외: "다른 공장 비품", 미등록: "원장에 없는 관리번호" }[result]} — ${esc(code)}<small>${esc([a?.name, a?.site, a?.dept, a?.user_name].filter(Boolean).join(" · "))}</small>`;
    beep(result === "정상");
    const ul = $("#auScans"); if (ul.querySelector(".muted")) ul.innerHTML = "";
    ul.insertAdjacentHTML("afterbegin", scanLi(rec));
    renderAuditSummary();
  } finally { S.busy = false; }
}
$("#auScans").onclick = async (e) => {
  if (!e.target.classList.contains("x")) return;
  const li = e.target.closest("li"), rec = S.records.find((r) => r.id === li.dataset.id);
  if (!rec || !confirm(`${rec.asset_no} 스캔을 취소할까요?`)) return;
  await DB.del("records", rec.id); S.records = S.records.filter((r) => r !== rec); li.remove(); renderAuditSummary();
};
$("#btnMissing").onclick = () => {
  cam2.pause();
  const au = S.audit, found = new Set(auditStats().scans.map((s) => s.asset_no));
  const ms = [...S.assets.values()].filter((a) => !["폐기", "분실"].includes(a.status) && (!au.site || a.site === au.site) && !found.has(a.asset_no))
    .sort((x, y) => (x.dept || "").localeCompare(y.dept || "") || x.asset_no.localeCompare(y.asset_no));
  openSheet(`<h3 style="margin:4px 0 10px">미확인 비품 ${ms.length}건</h3><ul class="list">${ms.length ? ms.map((a) => `<li><div class="main"><div><b>${esc(a.asset_no)}</b> ${esc(a.name || "")}</div>
    <small>${esc([a.category, a.site, a.dept, a.user_name, a.location].filter(Boolean).join(" · "))}</small></div></li>`).join("") : `<li class="muted">모두 확인되었습니다 🎉</li>`}</ul>
    <p class="hint">이 폰에서 스캔한 것만 기준입니다. 여러 명이 나눠 스캔했다면 PC에서 합산된 결과를 확인하세요.</p>
    <div class="actions"><button class="btn primary" id="shCancel">닫기</button></div>`);
  $("#shCancel").onclick = () => closeSheet();
};
$("#btnEndAudit").onclick = async () => {
  if (!confirm(`'${S.audit.name}' 실사를 이 폰에서 종료할까요?\n스캔 기록은 남아 있고, [결과 보내기]로 PC에 전달하면 됩니다.`)) return;
  await DB.del("meta", "audit"); S.audit = null; history.back();
};

/* ============================================================ 관리 */
async function openMenu() {
  show("v-menu", "관리");
  let info = `원장 ${S.assets.size}건 · 기록 ${S.records.length}건 (미전송 ${pending().length}건)`;
  try {
    if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); info += `<br>사용 용량 ${(e.usage / 1048576).toFixed(1)}MB`; }
    if (navigator.storage?.persisted) info += `<br>영구 저장: ${(await navigator.storage.persisted()) ? "허용됨" : "미허용 (홈 화면에 추가 권장)"}`;
  } catch {}
  $("#storageInfo").innerHTML = info;
}
$("#mExportAll").onclick = () => exportRecords(true);
$("#mLedger").onclick = () => $("#fileLedger").click();
$("#mClearSent").onclick = async () => {
  const sent = S.records.filter((r) => r.sent && !(S.audit && r.audit_id === S.audit.id));
  if (!sent.length) return toast("정리할 보낸 기록이 없습니다.", "warn");
  if (!confirm(`보낸 기록 ${sent.length}건을 폰에서 삭제할까요?\n(PC에 업로드한 뒤에만 정리하세요)`)) return;
  await DB.run("records", "readwrite", (s) => { sent.forEach((r) => s.delete(r.id)); });
  const ids = new Set(sent.map((r) => r.id)); S.records = S.records.filter((r) => !ids.has(r.id));
  toast(`${sent.length}건 정리`); openMenu();
};
$("#mReset").onclick = async () => {
  const p = pending().length;
  if (!confirm(`원장과 모든 기록을 삭제합니다.${p ? `\n⚠ 보내지 않은 기록 ${p}건도 사라집니다!` : ""}\n계속할까요?`)) return;
  await Promise.all([DB.clear("assets"), DB.clear("records"), DB.clear("meta")]);
  await loadAll(); toast("초기화했습니다."); openMenu();
};

/* ============================================================ 시작 */
(async function init() {
  $("#ver").textContent = `v${APP_VERSION} · 오프라인 모드`;
  renderWorker();
  history.replaceState({ v: "home" }, "");
  try { await DB.open(); await loadAll(); }
  catch (e) { $("#notices").innerHTML = `<div class="notice">이 브라우저에서 저장소를 열 수 없습니다 (사생활 보호 모드 등). ${esc(e?.message || e)}</div>`; return; }
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  renderHome();
})();
