/* 전산비품 실사 — 모바일 스캐너 (오프라인)
 * 원장은 PC 웹에서 관리. 폰은 "구분 · 관리번호 · 위치"만 기록해 엑셀로 넘긴다.
 */
const APP_VERSION = "1.3.0";
const SITES = ["평택", "용인"];

/* ============================================================ 공통 */
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
const TYPE_CLASS = { 입고: "t-in", 출고: "t-out", 실사: "t-audit" };
const typeBadge = (t) => `<span class="badge ${TYPE_CLASS[t] || ""}">${esc(t)}</span>`;
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
const ym = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

/* ============================================================ 저장소 (IndexedDB) */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("asset-scan", 2);
      r.onupgradeneeded = () => {
        const d = r.result, have = d.objectStoreNames;
        if (!have.contains("records")) d.createObjectStore("records", { keyPath: "id" });
        if (!have.contains("meta")) d.createObjectStore("meta");
        if (!have.contains("ledger")) d.createObjectStore("ledger", { keyPath: "asset_no" });   // v1.3 조회용 원장
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  run(name, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(name, mode), req = fn(t.objectStore(name));
      t.oncomplete = () => res(req && "result" in req ? req.result : undefined);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  all: (n) => DB.run(n, "readonly", (s) => s.getAll()),
  put: (n, v, k) => DB.run(n, "readwrite", (s) => (k === undefined ? s.put(v) : s.put(v, k))),
  get: (n, k) => DB.run(n, "readonly", (s) => s.get(k)),
  del: (n, k) => DB.run(n, "readwrite", (s) => s.delete(k)),
  clear: (n) => DB.run(n, "readwrite", (s) => s.clear()),
};

const S = { records: [], lastExport: null, mode: "", session: [], busy: false, ledger: new Map(), ledgerMeta: null };
const site = () => { const v = store.get("site"); return SITES.includes(v) ? v : ""; };
const pending = () => S.records.filter((r) => !r.sent);

async function loadAll() {
  const [records, lastExport, ledger, ledgerMeta] = await Promise.all([DB.all("records"), DB.get("meta", "lastExport"),
    DB.all("ledger"), DB.get("meta", "ledger")]);
  S.records = records.sort((a, b) => (a.at < b.at ? -1 : 1)); S.lastExport = lastExport || null;
  S.ledger = new Map(ledger.map((a) => [a.asset_no, a])); S.ledgerMeta = ledgerMeta || null;
}

/* ============================================================ 조회용 원장 (PC에서 받은 엑셀) */
const LEDGER_ALIASES = {
  asset_no: ["관리번호"], name: ["명칭", "품명"], category: ["장비구분"], status: ["비품상태", "상태"],
  site: ["공장"], dept: ["부서명"], user_empno: ["사용자", "사번"], user_name: ["사용자명", "성명"],
  location: ["보관위치", "위치"], model: ["모델명", "사양"], serial_no: ["시리얼번호"],
};
function parseLedger(buf, file) {
  const wb = XLSX.read(buf, { type: "array" });
  const all = new Set(Object.values(LEDGER_ALIASES).flat());
  let best = null;
  for (const sn of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: "" });
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const hdr = rows[i].map((v) => String(v).trim());
      if (!hdr.includes("관리번호")) continue;
      const score = hdr.filter((h) => all.has(h)).length;
      if (score >= 3 && (!best || score > best.score)) best = { score, sn, rows, i, hdr };
    }
  }
  if (!best) throw new Error("'관리번호'가 있는 원장 엑셀이 아닙니다. PC의 [모바일 조회용 원장] 파일을 선택하세요.");
  const col = {};
  for (const [f, al] of Object.entries(LEDGER_ALIASES)) { const j = best.hdr.findIndex((h) => al.includes(h)); if (j >= 0) col[f] = j; }
  const out = new Map();
  for (const r of best.rows.slice(best.i + 1)) {
    const no = normNo(r[col.asset_no]); if (!no) continue;
    const a = { asset_no: no };
    for (const [f, j] of Object.entries(col)) if (f !== "asset_no") a[f] = String(r[j] ?? "").trim();
    out.set(no, a);
  }
  // 기준시각: 시트명 '원장 2026-11-18 17-30' → 없으면 파일 수정시각
  const m = best.sn.match(/(\d{4}-\d{2}-\d{2})[ _](\d{2})-(\d{2})/);
  const base = m ? `${m[1]} ${m[2]}:${m[3]}` : nowStr(new Date(file.lastModified || Date.now())).slice(0, 16);
  return { assets: [...out.values()], base };
}
async function importLedger(file) {
  try {
    const r = parseLedger(new Uint8Array(await file.arrayBuffer()), file);
    if (!r.assets.length) throw new Error("비품 행이 없습니다.");
    await DB.run("ledger", "readwrite", (s) => { s.clear(); r.assets.forEach((a) => s.put(a)); });
    S.ledger = new Map(r.assets.map((a) => [a.asset_no, a]));
    S.ledgerMeta = { file: file.name, base: r.base, count: r.assets.length, at: nowStr() };
    await DB.put("meta", S.ledgerMeta, "ledger");
    toast(`조회용 원장 ${r.assets.length.toLocaleString()}건을 불러왔습니다.`); renderHome();
    if ($(".view.on")?.id === "v-look") renderLookBase();
  } catch (err) { toast(err.message, "err", 4500); }
}
$("#btnLedger").onclick = () => $("#fileLedger").click();
$("#fileLedger").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importLedger(f); };
const ledgerLine = (a) => [a.name, a.user_name ? `${a.user_name}${a.dept ? "(" + a.dept + ")" : ""}` : a.dept, a.status].filter(Boolean).join(" · ");

/* ============================================================ 위치 선택 */
function renderSites() {
  $$(".site-seg").forEach((el) => {
    el.style.setProperty("--n", SITES.length);
    el.innerHTML = SITES.map((s) => `<button type="button" class="${s === site() ? "on" : ""}" data-site="${s}">${s}</button>`).join("");
  });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-site]"); if (!b) return;
  store.set("site", b.dataset.site); renderSites();
});
function ensureSite() {
  if (site()) return true;
  toast("먼저 위치(평택/용인)를 선택하세요.", "warn"); beep(false);
  $("#siteHome").animate([{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(0)" }], 300);
  return false;
}

/* ============================================================ 카메라 */
class Cam {
  constructor(elId, btnId, onCode) {
    this.elId = elId; this.btn = $("#" + btnId); this.onCode = onCode; this.h = null; this.last = ""; this.lastAt = 0;
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
      formatsToSupport: [F.QR_CODE, F.CODE_128, F.CODE_39, F.CODE_93, F.DATA_MATRIX, F.EAN_13, F.EAN_8, F.ITF, F.CODABAR, F.UPC_A],
    });
    try {
      await this.h.start({ facingMode: "environment" },
        { fps: 12, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: Math.max(s, Math.floor(w * 0.6)), height: s }; } },
        (t) => this.hit(t), () => {});
    } catch (e) {
      this.h = null; this.btn.textContent = "다시 시도";
      this.msg(`카메라를 열 수 없습니다.<br><small>${esc(e?.message || e)}</small><br><br>설정에서 카메라 권한을 허용하세요.`);
    }
  }
  hit(t) {
    const n = Date.now(); if (t === this.last && n - this.lastAt < 2500) return;   // 같은 코드 연속 인식 방지
    this.last = t; this.lastAt = n; this.onCode(t);
  }
  async stop(byUser = false) {
    if (this.h) { try { await this.h.stop(); } catch {} try { this.h.clear(); } catch {} this.h = null; }
    if (byUser) { this.msg("카메라가 꺼져 있습니다."); this.btn.textContent = "카메라 켜기"; }
  }
}
const cam = new Cam("reader", "btnCam", (c) => onScan(c));

/* 블루투스/PDA 스캐너 (키보드 입력) */
let kbBuf = "", kbAt = 0;
document.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  const vw = $(".view.on")?.id;
  if (vw !== "v-scan" && vw !== "v-look") return;
  const t = Date.now(); if (t - kbAt > 300) kbBuf = ""; kbAt = t;
  if (e.key === "Enter") { if (kbBuf.length >= 3) { vw === "v-look" ? lookShow(normNo(kbBuf), true) : onScan(kbBuf); e.preventDefault(); } kbBuf = ""; }
  else if (e.key.length === 1) kbBuf += e.key;
});

/* ============================================================ 화면 전환 */
function show(id, title, back = true) {
  $$(".view").forEach((v) => v.classList.toggle("on", v.id === id));
  $("#title").textContent = title; $("#btnBack").hidden = !back; window.scrollTo(0, 0);
}
async function goHome() { S.mode = ""; await Promise.all([cam.stop(), cam2.stop()]); show("v-home", "전산비품 실사", false); renderSites(); renderHome(); }
$("#btnBack").onclick = () => history.back();
window.addEventListener("popstate", goHome);
function renderWorker() { $("#btnWorker").textContent = "👤 " + (Worker.get() || "작업자 설정"); }
$("#btnWorker").onclick = () => { const v = prompt("작업자 이름", Worker.get()); if (v && v.trim()) { Worker.set(v); renderWorker(); } };

$$("[data-go]").forEach((b) => (b.onclick = () => {
  if (!ensureSite() || !Worker.ensure()) return;
  renderWorker(); openScan(b.dataset.go);
}));
$("#btnMenu").onclick = () => { history.pushState({ v: "menu" }, ""); openMenu(); };

/* ============================================================ 홈 */
function renderHome() {
  const p = pending().length;
  $("#cntPending").textContent = p; $("#cntPending").classList.toggle("pending", p > 0);
  $("#lastExport").textContent = S.lastExport ? `마지막 전송 ${S.lastExport.slice(5, 16)}` : "";
  const notes = [];
  const ios = /iphone|ipad/i.test(navigator.userAgent), standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (!standalone) notes.push(`<div class="notice"><b>홈 화면에 추가</b>해서 사용하세요. ${ios ? "Safari 공유 버튼 → '홈 화면에 추가'" : "Chrome 메뉴(⋮) → '앱 설치' 또는 '홈 화면에 추가'"}${ios ? "<br><small>추가하지 않으면 오래 안 쓸 때 기록이 지워질 수 있습니다.</small>" : ""}</div>`);
  if (p && S.records.some((r) => !r.sent && Date.now() - new Date(r.at.replace(" ", "T")) > 2 * 864e5))
    notes.push(`<div class="notice warn">2일 넘게 보내지 않은 기록이 있습니다. [결과 보내기]로 PC에 전달하세요.</div>`);
  $("#notices").innerHTML = notes.join("");
  const lm = S.ledgerMeta;
  $("#ledgerInfo").innerHTML = lm ? `${lm.count.toLocaleString()}건 · <b>${esc(lm.base)}</b> 기준` : `<span class="muted">불러온 원장 없음 (조회할 때만 필요)</span>`;
  $("#btnLedger").textContent = lm ? "새로 불러오기" : "원장 불러오기";
  const rec = S.records.slice(-15).reverse();
  $("#recent").innerHTML = rec.length ? rec.map((r) => `<li>${typeBadge(r.type)}<div class="main"><div><b>${esc(r.asset_no)}</b></div>
      <small>${esc([r.site, r.reason, r.user_name, r.audit_name].filter(Boolean).join(" · "))}${r.sent ? " · 전송됨" : ""}</small></div>
      <small>${esc(r.at.slice(5, 16))}</small></li>`).join("") : `<li class="muted">기록이 없습니다.</li>`;
}

/* ============================================================ 스캔 */
const MODE_BADGE = { 입고: "t-in", 출고: "t-out", 실사: "t-audit" };
const REASONS = { 입고: ["퇴사회수", "교체회수", "포맷완료", "기타"], 출고: ["신규지급", "교체지급", "포맷의뢰", "기타"] };
const VENDOR = ["포맷의뢰"];
const curReason = () => $("#exReason .chip2.on")?.dataset.r || "";
function openScan(mode) {
  S.mode = mode; S.session = [];
  history.pushState({ v: mode }, "");
  show("v-scan", `${mode} 스캔`);
  $("#modeBadge").className = `badge ${MODE_BADGE[mode]}`; $("#modeBadge").textContent = mode;
  renderSites();
  const ex = $("#extra");
  const reasons = REASONS[mode];
  const cur = reasons && (reasons.includes(store.get("reason_" + mode)) ? store.get("reason_" + mode) : reasons[0]);
  const chips = reasons ? `<div class="lbl">사유</div><div class="chips" id="exReason">${reasons.map((r) =>
    `<button type="button" class="chip2 ${r === cur ? "on" : ""}" data-r="${r}">${r}</button>`).join("")}</div>` : "";
  if (mode === "출고") ex.innerHTML = chips + `<label class="f" style="margin-top:10px"><span id="exUserLbl"></span>
      <input id="exUser" value="${esc(store.get("out_user"))}"></label>`;
  else if (mode === "실사") ex.innerHTML = `<label class="f">실사명 (PC에서 같은 이름끼리 합쳐집니다)
      <input id="exAudit" value="${esc(store.get("audit_name") || ym() + " 정기실사")}"></label>`;
  else ex.innerHTML = chips;
  const syncUserLbl = () => {
    if (mode !== "출고") return;
    const vendor = VENDOR.includes(curReason());
    $("#exUserLbl").textContent = vendor ? "업체명 (선택)" : "출고 대상자 (선택 · 여러 개를 한 사람에게 줄 때 유지)";
    $("#exUser").placeholder = vendor ? "예: OO컴퓨터" : "이름 (비워두면 PC에서 지정)";
  };
  $("#exReason")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-r]"); if (!b) return;
    $$("#exReason .chip2").forEach((x) => x.classList.toggle("on", x === b));
    store.set("reason_" + mode, b.dataset.r); syncUserLbl();
  });
  syncUserLbl();
  $("#exUser")?.addEventListener("change", (e) => store.set("out_user", e.target.value.trim()));
  $("#exAudit")?.addEventListener("change", (e) => store.set("audit_name", e.target.value.trim()));
  $("#banner").className = "banner";
  renderSession();
  cam.start();
}
$("#manualForm").onsubmit = (e) => { e.preventDefault(); const v = $("#manualInput").value; $("#manualInput").value = ""; $("#manualInput").blur(); if (v.trim()) onScan(v); };

async function onScan(raw) {
  const code = normNo(raw);
  if (!code || S.busy || !S.mode) return;
  if (!ensureSite()) return;
  S.busy = true;
  try {
    const audit = S.mode === "실사" ? ($("#exAudit")?.value.trim() || ym() + " 정기실사") : "";
    const user = S.mode === "출고" ? ($("#exUser")?.value.trim() || "") : "";
    const dup = S.records.find((r) => !r.sent && r.type === S.mode && r.asset_no === code && (S.mode !== "실사" || r.audit_name === audit));
    const b = $("#banner");
    if (dup) {
      b.className = "banner on dup"; b.innerHTML = `이미 기록됨 — ${esc(code)}<small>${esc(dup.at.slice(11, 16))} ${esc(dup.site)}에서 ${S.mode}</small>`;
      beep(false); return;
    }
    const reason = S.mode === "실사" ? "" : curReason();
    const rec = { id: uid(), at: nowStr(), type: S.mode, asset_no: code, site: site(), location: site(), worker: Worker.get(),
      device: "모바일", sent: 0, reason, user_name: user, audit_name: audit, audit_site: S.mode === "실사" ? site() : "" };
    await DB.put("records", rec); S.records.push(rec); S.session.unshift(rec);
    const la = S.ledger.get(code);
    const ld = !S.ledger.size ? "" : la ? `<small class="ld">원장: ${esc(ledgerLine(la))}</small>` : `<small class="ld">⚠ 원장(${esc(S.ledgerMeta.base)} 기준)에 없는 번호 — 번호를 확인하세요</small>`;
    b.className = `banner on ${S.ledger.size && !la ? "dup" : "ok"}`;
    b.innerHTML = `${S.mode} 기록 — ${esc(code)}<small>${esc([site(), reason, user, audit].filter(Boolean).join(" · "))}</small>${ld}`;
    beep(!(S.ledger.size && !la)); renderSession();
  } finally { S.busy = false; }
}
function renderSession() {
  $("#sessionTitle").textContent = `이번 ${S.mode} ${S.session.length}건`;
  $("#sessionList").innerHTML = S.session.length ? S.session.map((r) => `<li data-id="${r.id}"><div class="main"><div><b>${esc(r.asset_no)}</b> ${esc(S.ledger.get(r.asset_no)?.name || "")}</div>
    <small>${esc([r.site, r.reason, r.user_name, r.audit_name].filter(Boolean).join(" · "))}</small></div>
    <small>${r.at.slice(11, 16)}</small><button class="x" title="삭제">×</button></li>`).join("") : `<li class="muted">바코드를 찍으세요.</li>`;
}
$("#sessionList").onclick = async (e) => {
  if (!e.target.classList.contains("x")) return;
  const id = e.target.closest("li").dataset.id, r = S.records.find((x) => x.id === id);
  if (!r || !confirm(`${r.asset_no} 기록을 지울까요?`)) return;
  await DB.del("records", id);
  S.records = S.records.filter((x) => x.id !== id); S.session = S.session.filter((x) => x.id !== id);
  renderSession(); toast("삭제했습니다.");
};

/* ============================================================ 조회 (원장 기준) */
const cam2 = new Cam("reader2", "btnCam2", (c) => lookShow(normNo(c), true));
function renderLookBase() {
  const lm = S.ledgerMeta;
  $("#lookNoLedger").hidden = !!lm;
  $("#lookBase").textContent = lm ? `원장 ${lm.count.toLocaleString()}건 · ${lm.base} 기준 (${lm.file}). 그 뒤 PC에서 바뀐 내용은 새 원장을 받아야 보입니다.` : "";
}
function openLook() {
  history.pushState({ v: "look" }, "");
  show("v-look", "원장 조회");
  $("#lookResult").innerHTML = ""; $("#lookListCard").hidden = true; $("#lookInput").value = "";
  renderLookBase();
  cam2.start();
}
$("#btnLook").onclick = openLook;
function lookShow(no, fromScan = false) {
  const a = S.ledger.get(no);
  const mine = S.records.filter((r) => r.asset_no === no).slice(-5).reverse();
  if (fromScan) beep(!!a || !S.ledger.size);
  const hist = mine.length ? `<h2 style="margin:12px 0 6px;font-size:14px">이 폰의 기록</h2><ul class="list">${mine.map((r) => `<li>${typeBadge(r.type)}<div class="main">
      <div>${esc([r.reason, r.user_name, r.audit_name].filter(Boolean).join(" · ") || r.site)}</div><small>${esc(r.site)}${r.sent ? " · 전송됨" : " · 미전송"}</small></div>
      <small>${esc(r.at.slice(5, 16))}</small></li>`).join("")}</ul>` : "";
  if (!a) {
    $("#lookResult").innerHTML = `<div class="banner on dup">원장에 없는 관리번호 — ${esc(no)}<small>${S.ledgerMeta ? `${esc(S.ledgerMeta.base)} 기준 원장에 없습니다. 새로 등록된 비품이면 PC에서 새 원장을 받아 보세요.` : "조회용 원장을 먼저 불러오세요."}</small></div>${hist ? `<div class="card">${hist}</div>` : ""}`;
    return;
  }
  const user = [a.user_empno, a.user_name].filter(Boolean).join(" ");
  const rows = [["상태", statusBadge(a.status)], ["사용자", esc(user || "-")], ["부서", esc(a.dept || "-")], ["장비구분", esc(a.category)],
    ["공장", esc(a.site)], ["보관위치", esc(a.location)], ["모델·사양", esc(a.model)], ["시리얼", esc(a.serial_no)]].filter(([, v]) => v && v !== "");
  $("#lookResult").innerHTML = `<div class="card asset-card"><div class="no">${esc(a.asset_no)}</div><div class="nm">${esc(a.name || "")}</div>
    <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>${hist}</div>`;
}
const STATUS_CLASS = { 사용중: "s-use", 재고: "s-stock", 예비장비: "s-stock", 수리의뢰: "s-repair", 포맷중: "s-repair", 폐기대상: "s-dispose", 폐기: "s-dead", 폐기완료: "s-dead", 분실: "s-dead" };
const statusBadge = (s) => `<span class="badge ${STATUS_CLASS[s] || ""}">${esc(s || "-")}</span>`;
$("#lookForm").onsubmit = (e) => {
  e.preventDefault();
  const q = $("#lookInput").value.trim(); $("#lookInput").blur();
  if (!q) return;
  if (!S.ledger.size) { renderLookBase(); return toast("조회용 원장을 먼저 불러오세요.", "warn"); }
  const nq = normNo(q);
  if (S.ledger.has(nq)) { $("#lookListCard").hidden = true; return lookShow(nq); }
  const hits = [...S.ledger.values()].filter((a) => a.asset_no.includes(nq) || (a.user_name || "").includes(q) || (a.dept || "").includes(q) || (a.name || "").toUpperCase().includes(nq));
  $("#lookResult").innerHTML = "";
  $("#lookListCard").hidden = false;
  $("#lookListTitle").textContent = `'${q}' 검색 결과 ${hits.length}건${hits.length > 100 ? " (앞 100건)" : ""}`;
  $("#lookList").innerHTML = hits.slice(0, 100).map((a) => `<li data-no="${esc(a.asset_no)}" style="cursor:pointer"><div class="main">
      <div><b>${esc(a.asset_no)}</b> ${esc(a.name || "")}</div><small>${esc([a.user_name, a.dept, a.site].filter(Boolean).join(" · "))}</small></div>${statusBadge(a.status)}</li>`).join("")
    || `<li class="muted">찾는 비품이 없습니다.</li>`;
};
$("#lookList").onclick = (e) => { const li = e.target.closest("[data-no]"); if (li) { lookShow(li.dataset.no); window.scrollTo({ top: 0, behavior: "smooth" }); } };

/* ============================================================ 결과 내보내기 */
const EXPORT_COLS = [["id", "기록ID"], ["at", "일시"], ["type", "구분"], ["asset_no", "관리번호"], ["site", "위치"], ["reason", "사유"],
  ["user_name", "사용자명"], ["audit_name", "실사명"], ["audit_site", "실사범위"], ["worker", "작업자"], ["device", "기기"]];

async function exportRecords(all = false) {
  const list = all ? S.records : pending();
  if (!list.length) return toast("보낼 기록이 없습니다.", "warn");
  const aoa = [EXPORT_COLS.map(([, h]) => h), ...list.map((r) => EXPORT_COLS.map(([k]) => r[k] ?? ""))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = EXPORT_COLS.map(([k]) => ({ wch: { id: 10, at: 19, asset_no: 15, audit_name: 16 }[k] || 9 }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "모바일기록");
  const d = new Date();
  const name = `비품스캔_${Worker.get() || "작업자"}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.xlsx`;
  const blob = new Blob([XLSX.write(wb, { type: "array", bookType: "xlsx" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const file = new File([blob], name, { type: blob.type });
  const cnt = list.reduce((o, r) => ((o[r.type] = (o[r.type] || 0) + 1), o), {});
  const summary = Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join(", ");
  let shared = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "전산비품 스캔 결과", text: `${summary} (${Worker.get()})` }); shared = true; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  if (!shared) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  if (!all && confirm(`${summary} — PC로 보냈나요?\n'확인'을 누르면 보낸 기록으로 표시합니다.`)) {
    const t = nowStr();
    for (const r of list) { r.sent = 1; r.sent_at = t; await DB.put("records", r); }
    S.lastExport = t; await DB.put("meta", t, "lastExport");
  }
  renderHome();
}
$("#btnExport").onclick = () => exportRecords(false);

/* ============================================================ 관리 */
async function openMenu() {
  show("v-menu", "관리");
  let info = `기록 ${S.records.length}건 (미전송 ${pending().length}건)` + (S.ledgerMeta ? `<br>조회용 원장 ${S.ledgerMeta.count.toLocaleString()}건 (${S.ledgerMeta.base} 기준)` : "");
  try {
    if (navigator.storage?.persisted) info += `<br>영구 저장: ${(await navigator.storage.persisted()) ? "허용됨" : "미허용 (홈 화면에 추가 권장)"}`;
  } catch {}
  $("#storageInfo").innerHTML = info;
}
$("#mExportAll").onclick = () => exportRecords(true);
$("#mLedgerDel").onclick = async () => {
  if (!S.ledger.size) return toast("불러온 원장이 없습니다.", "warn");
  if (!confirm("폰에 저장된 조회용 원장을 지울까요? (스캔 기록은 그대로)")) return;
  await DB.clear("ledger"); await DB.del("meta", "ledger"); S.ledger = new Map(); S.ledgerMeta = null; toast("조회용 원장을 지웠습니다."); openMenu();
};
$("#mClearSent").onclick = async () => {
  const sent = S.records.filter((r) => r.sent);
  if (!sent.length) return toast("정리할 보낸 기록이 없습니다.", "warn");
  if (!confirm(`보낸 기록 ${sent.length}건을 폰에서 삭제할까요?\n(PC에 업로드한 뒤에만 정리하세요)`)) return;
  await DB.run("records", "readwrite", (s) => { sent.forEach((r) => s.delete(r.id)); });
  S.records = S.records.filter((r) => !r.sent); toast(`${sent.length}건 정리`); openMenu();
};
$("#mReset").onclick = async () => {
  const p = pending().length;
  if (!confirm(`모든 기록을 삭제합니다.${p ? `\n⚠ 보내지 않은 기록 ${p}건도 사라집니다!` : ""}\n계속할까요?`)) return;
  await Promise.all([DB.clear("records"), DB.clear("meta")]); await loadAll(); toast("초기화했습니다."); openMenu();
};

/* ============================================================ 시작 */
(async function init() {
  $("#ver").textContent = `v${APP_VERSION}`;
  renderWorker(); renderSites();
  history.replaceState({ v: "home" }, "");
  try { await DB.open(); await loadAll(); }
  catch (e) { $("#notices").innerHTML = `<div class="notice warn">이 브라우저에서 저장소를 열 수 없습니다 (사생활 보호 모드 등). ${esc(e?.message || e)}</div>`; return; }
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  renderHome();
})();
