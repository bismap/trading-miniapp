const STORAGE_KEY = "trading_plan_v3";
const DEFAULT_DATA = {
  startCapital: 44.5,
  targetPercent: 10,
  goal: 1000,
  planYear: 2026,
  avgDaysBetweenSteps: 3,
  closed: [
    { step: 1, date: "2026-11-04" },
    { step: 2, date: "2026-11-07" },
    { step: 3, date: "2026-11-10" },
    { step: 4, date: "2026-11-11" },
    { step: 5, date: "2026-11-12" },
    { step: 6, date: "2026-11-13" },
    { step: 7, date: "2026-11-14" },
  ],
  // Separate top-ups (not tied to step %). Applied immediately.
  // Historical: the 10.6 that was on step 4 becomes a topup on that date
  topUps: [
    { id: "init-4", date: "2026-11-11", amount: 10.6 },
  ],
};

const tg = window.Telegram?.WebApp;
let state = null;
let currentFilter = "all";

function formatMoney(n) {
  if (n == null || isNaN(n)) return "—";
  return "$" + n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatMoneyShort(n) {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1000) return "$" + (n / 1000).toFixed(1) + "k";
  return "$" + n.toFixed(0);
}
function formatPct(n) {
  if (n == null || isNaN(n)) return "—";
  return (n * 100).toFixed(1) + "%";
}
function formatIntSpaces(n) {
  if (n == null || isNaN(n)) return "";
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
function parseGoalInput(str) {
  return Number(String(str || "").replace(/\s/g, "").replace(/,/g, "."));
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function haptic(t = "light") { try { tg?.HapticFeedback?.impactOccurred?.(t); } catch (_) {} }
function addDays(iso, days) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function yearEnd(y) { return y + "-12-31"; }
function yearOf(iso) { return iso ? Number(iso.slice(0, 4)) : null; }
function uid() { return "t" + Date.now() + Math.random().toString(36).slice(2, 6); }

function loadFromLocal() {
  try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; }
  catch { return null; }
}
function saveToLocal(d) { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); }
function loadData() {
  return new Promise((resolve) => {
    if (tg?.CloudStorage) {
      tg.CloudStorage.getItem(STORAGE_KEY, (err, value) => {
        if (!err && value) { try { resolve(JSON.parse(value)); return; } catch (_) {} }
        resolve(loadFromLocal() || structuredClone(DEFAULT_DATA));
      });
    } else resolve(loadFromLocal() || structuredClone(DEFAULT_DATA));
  });
}
function saveData(d) {
  saveToLocal(d);
  if (tg?.CloudStorage) tg.CloudStorage.setItem(STORAGE_KEY, JSON.stringify(d), () => {});
}

function calcAvgDays(closed) {
  const sorted = [...(closed || [])].filter(c => c.date).sort((a, b) => a.step - b.step);
  if (sorted.length < 2) return 3;
  let total = 0, n = 0;
  for (let i = 1; i < sorted.length; i++) {
    const diff = (new Date(sorted[i].date) - new Date(sorted[i - 1].date)) / 86400000;
    if (diff > 0) { total += diff; n++; }
  }
  return n ? Math.max(1, Math.round(total / n)) : 3;
}

/**
 * Build timeline events: topups + closed steps, chronological.
 * Then project plan steps after last event until planYear end.
 * Returns { steps: display rows, current, invested, timeline points for chart }
 */
function buildModel(data) {
  const rate = data.targetPercent / 100;
  const avgDays = data.avgDaysBetweenSteps || calcAvgDays(data.closed) || 3;
  const endDate = yearEnd(data.planYear || 2026);

  const events = [];
  (data.closed || []).forEach(c => {
    events.push({ type: "step", step: c.step, date: c.date });
  });
  (data.topUps || []).forEach(t => {
    events.push({ type: "topup", id: t.id, date: t.date, amount: Number(t.amount) || 0 });
  });
  // sort by date, then topup before step on same day (deposit first, then %), then by step
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.type !== b.type) return a.type === "topup" ? -1 : 1;
    return (a.step || 0) - (b.step || 0);
  });

  const rows = []; // for list display
  const chartPts = []; // {date, capital, kind}
  let capital = data.startCapital;
  let invested = data.startCapital;
  chartPts.push({ date: null, capital, kind: "start", label: "Старт" });

  let lastStep = 0;
  let lastDate = null;

  for (const ev of events) {
    if (ev.type === "topup") {
      capital += ev.amount;
      if (ev.amount > 0) invested += ev.amount;
      else invested = Math.min(invested, capital);
      if (invested < 0) invested = 0;
      rows.push({
        kind: "topup", id: ev.id, date: ev.date, amount: ev.amount,
        end: capital, invested, year: yearOf(ev.date),
      });
      chartPts.push({ date: ev.date, capital, kind: "topup" });
    } else {
      const start = capital;
      const end = start * (1 + rate);
      capital = end;
      lastStep = ev.step;
      lastDate = ev.date;
      rows.push({
        kind: "step", status: "closed", step: ev.step, date: ev.date,
        start, end, invested, profit: end - invested,
        growth: invested > 0 ? end / invested - 1 : 0,
        year: yearOf(ev.date),
      });
      chartPts.push({ date: ev.date, capital, kind: "closed", step: ev.step });
    }
  }

  // Project plan steps
  let stepNum = lastStep;
  let cursor = lastDate || todayISO();
  let guard = 0;
  while (guard++ < 500) {
    stepNum++;
    cursor = addDays(cursor, avgDays);
    if (cursor > endDate) break;
    const start = capital;
    const end = start * (1 + rate);
    rows.push({
      kind: "step", status: "plan", step: stepNum, date: cursor,
      start, end, invested, profit: end - invested,
      growth: invested > 0 ? end / invested - 1 : 0,
      year: yearOf(cursor),
    });
    chartPts.push({ date: cursor, capital: end, kind: "plan", step: stepNum });
    capital = end; // for chaining plan only; real current is before plan
  }

  // Real current = after all closed events (not plan)
  let realCapital = data.startCapital;
  let realInvested = data.startCapital;
  for (const ev of events) {
    if (ev.type === "topup") {
      realCapital += ev.amount;
      if (ev.amount > 0) realInvested += ev.amount;
      else realInvested = Math.min(realInvested, realCapital);
      if (realInvested < 0) realInvested = 0;
    } else {
      realCapital *= (1 + rate);
    }
  }

  return {
    rows,
    chartPts,
    current: realCapital,
    invested: realInvested,
    lastStep,
    nextStep: lastStep + 1,
  };
}

function getSummary(model, data) {
  const profit = model.current - model.invested;
  const growth = model.invested > 0 ? model.current / model.invested - 1 : 0;
  const progress = Math.min(100, (model.current / data.goal) * 100);
  let stepsToGoal = "—";
  if (model.current >= data.goal) stepsToGoal = "цель достигнута";
  else if (data.targetPercent > 0) {
    const n = Math.ceil(Math.log(data.goal / model.current) / Math.log(1 + data.targetPercent / 100));
    stepsToGoal = "≈ " + n + " шагов";
  }
  const closedCount = (data.closed || []).length;
  return { profit, growth, progress, stepsToGoal, closedCount };
}

function drawChart(model) {
  const canvas = document.getElementById("growth-chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 340;
  const cssH = 260;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = { t: 40, r: 14, b: 40, l: 58 };
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;

  // Only FACT points for the main story: start + closed steps + topups
  const real = model.chartPts.filter(p => p.kind !== "plan");
  if (real.length < 1) {
    ctx.fillStyle = "#9a9a9a";
    ctx.font = "14px -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Пока нет данных для графика", cssW / 2, cssH / 2);
    return;
  }

  // If only 1 point, duplicate for line
  const pts = real.length === 1 ? [real[0], real[0]] : real;
  const vals = pts.map(p => p.capital);
  let minV = Math.min(...vals);
  let maxV = Math.max(...vals);
  if (minV === maxV) { minV = minV * 0.9; maxV = maxV * 1.1 || 1; }
  const padV = (maxV - minV) * 0.15;
  minV = Math.max(0, minV - padV);
  maxV = maxV + padV;
  const range = maxV - minV;

  function xy(i, v) {
    const n = Math.max(pts.length - 1, 1);
    return [pad.l + (w * i) / n, pad.t + h - ((v - minV) / range) * h];
  }

  // Card-like plot background
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  ctx.fillRect(pad.l, pad.t, w, h);

  // Grid + Y labels (bright enough to read)
  ctx.font = "600 11px -apple-system, BlinkMacSystemFont, sans-serif";
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (h * i) / 4;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + w, y); ctx.stroke();
    const val = maxV - (range * i) / 4;
    ctx.fillStyle = "#b0b0b5";
    ctx.textAlign = "right";
    ctx.fillText(formatMoneyShort(val), pad.l - 8, y + 4);
  }

  // Area under curve
  const areaGrad = ctx.createLinearGradient(0, pad.t, 0, pad.t + h);
  areaGrad.addColorStop(0, "rgba(42, 171, 238, 0.45)");
  areaGrad.addColorStop(0.7, "rgba(42, 171, 238, 0.12)");
  areaGrad.addColorStop(1, "rgba(42, 171, 238, 0)");
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = xy(i, p.capital);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  {
    const [xL] = xy(pts.length - 1, pts[pts.length - 1].capital);
    const [xF] = xy(0, pts[0].capital);
    ctx.lineTo(xL, pad.t + h);
    ctx.lineTo(xF, pad.t + h);
  }
  ctx.closePath();
  ctx.fillStyle = areaGrad;
  ctx.fill();

  // Main line
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = xy(i, p.capital);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#5ac8fa";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  // Points
  pts.forEach((p, i) => {
    if (real.length === 1 && i === 1) return;
    const [x, y] = xy(i, p.capital);
    const top = p.kind === "topup";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = top ? "#ffd60a" : "#5ac8fa";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#1c1c1e";
    ctx.stroke();
  });

  // Value tags first & last (dark bg, white text — always readable)
  function tag(x, y, text, side) {
    ctx.font = "700 12px -apple-system, sans-serif";
    const tw = ctx.measureText(text).width;
    const bw = tw + 14, bh = 22;
    let bx = side === "left" ? x + 8 : x - bw - 8;
    bx = Math.max(pad.l, Math.min(bx, cssW - bw - 6));
    let by = y - bh - 8;
    if (by < 4) by = y + 10;
    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    roundRect(ctx, bx + 1, by + 1, bw, bh, 8);
    ctx.fill();
    ctx.fillStyle = "#2c2c2e";
    roundRect(ctx, bx, by, bw, bh, 8);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.fillText(text, bx + 7, by + 15);
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  const [x0, y0] = xy(0, pts[0].capital);
  const lastI = real.length === 1 ? 0 : pts.length - 1;
  const [x1, y1] = xy(lastI, pts[lastI].capital);
  tag(x0, y0, formatMoney(pts[0].capital), "left");
  if (real.length > 1) tag(x1, y1, formatMoney(pts[lastI].capital), "right");

  // X dates
  ctx.fillStyle = "#9a9aa0";
  ctx.font = "600 10px -apple-system, sans-serif";
  ctx.textAlign = "center";
  const idxs = [0];
  if (real.length > 2) idxs.push(Math.floor((real.length - 1) / 2));
  if (real.length > 1) idxs.push(real.length - 1);
  idxs.forEach(i => {
    const p = real[i];
    if (!p || !p.date) return;
    const [x] = xy(i, p.capital);
    ctx.fillText(p.date.slice(5).replace("-", "."), x, cssH - 12);
  });

  const stats = document.getElementById("chart-stats");
  if (stats) {
    const a = real[0].capital;
    const b = real[real.length - 1].capital;
    const g = a > 0 ? ((b / a - 1) * 100).toFixed(0) : "0";
    stats.textContent = formatMoney(a) + " → " + formatMoney(b) + "  ·  +" + g + "%";
  }
}

function render() {
  if (!state) return;
  state.avgDaysBetweenSteps = calcAvgDays(state.closed);
  if (!state.topUps) state.topUps = [];
  if (!state.planYear) state.planYear = 2026;

  const model = buildModel(state);
  const sum = getSummary(model, state);

  document.getElementById("current-capital").textContent = formatMoney(model.current);
  document.getElementById("profit").textContent = (sum.profit >= 0 ? "+" : "") + formatMoney(sum.profit);
  document.getElementById("growth-pct").textContent = formatPct(sum.growth);
  document.getElementById("invested-line").textContent = "Вложено: " + formatMoney(model.invested);
  document.getElementById("goal-text").textContent = formatMoney(state.goal);
  document.getElementById("progress-fill").style.width = sum.progress + "%";
  let remainSteps = 0;
  if (model.current < state.goal && state.targetPercent > 0) {
    remainSteps = Math.ceil(Math.log(state.goal / model.current) / Math.log(1 + state.targetPercent / 100));
  }
  document.getElementById("progress-meta").textContent =
    "Пройдено " + sum.closedCount + " шагов  ·  Осталось " + remainSteps + " шагов";

  document.getElementById("param-start").value = state.startCapital;
  document.getElementById("param-pct").value = state.targetPercent;
  document.getElementById("param-goal").value = formatIntSpaces(state.goal);
  document.getElementById("header-sub").textContent =
    state.targetPercent + "% за шаг · цель " + formatMoney(state.goal);
  document.getElementById("trading-year-label").textContent = "Закрывай шаги в таблице";

  drawChart(model);

  // Group rows by year
  const list = document.getElementById("steps-list");
  let rows = model.rows;
  if (currentFilter === "closed") {
    rows = rows.filter(r => r.kind === "topup" || (r.kind === "step" && r.status === "closed"));
  } else if (currentFilter === "plan") {
    rows = rows.filter(r => r.kind === "step" && r.status === "plan");
  }

  const byYear = {};
  rows.forEach(r => {
    const y = r.year || yearOf(r.date) || 2026;
    if (!byYear[y]) byYear[y] = [];
    byYear[y].push(r);
  });
  // ensure years from 2026..planYear exist for plan view structure
  const maxYear = state.planYear || 2026;
  for (let y = 2026; y <= maxYear; y++) {
    if (!byYear[y]) byYear[y] = [];
  }
  const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  const lastClosedStep = model.lastStep;

  if (!years.length || (rows.length === 0 && currentFilter !== "all")) {
    list.innerHTML = '<div class="empty">Пусто</div>';
  } else {
    let html = "";
    years.forEach((y, yi) => {
      const yearRows = byYear[y] || [];
      const isFutureYear = y > 2026;
      html += '<div class="year-section">';
      html += '<div class="year-title">' + y + ' год</div>';
      if (isFutureYear) {
        html += '<div class="year-plan-box muted">';
      } else {
        html += '<div class="year-plan-box">';
      }

      if (!yearRows.length) {
        html += '<div class="empty" style="padding:12px">Нет шагов</div>';
      } else {
        yearRows.forEach(r => {
          if (r.kind === "topup") {
            const isOut = r.amount < 0;
            const rowCls = isOut ? "topup-out" : "topup-in";
            const badgeCls = isOut ? "topup-out" : "topup-in";
            html += '<div class="step-row ' + rowCls + '">' +
              '<div class="step-num">' + (isOut ? "↓" : "↑") + '</div>' +
              '<div class="step-body"><div class="step-main"><span class="badge ' + badgeCls + '">' +
              (isOut ? "Вывод" : "Пополнение") + '</span> ' + formatMoney(Math.abs(r.amount)) +
              '</div><div class="step-meta">' + r.date + '</div></div>' +
              '<div class="step-right">' + formatMoney(r.end) + '</div></div>';
            return;
          }
          const isNext = r.status === "plan" && r.step === model.nextStep;
          const isLastClosed = r.status === "closed" && r.step === lastClosedStep;
          const badge = r.status === "closed"
            ? '<span class="badge closed">Закрыт</span>'
            : (isNext ? '<span class="badge closed" style="background:rgba(42,171,238,0.25);color:#5ac8fa">Следующий</span>' : '<span class="badge plan">План</span>');
          let right = "";
          if (isNext) {
            right = '<button class="btn btn-primary btn-sm btn-close-row" data-step="' + r.step + '">Закрыть</button>';
          } else if (isLastClosed) {
            right = '<button class="btn-danger-ghost btn-undo" data-step="' + r.step + '">Отменить</button>' +
              formatMoney(r.profit) + '<div class="pct">' + formatPct(r.growth) + '</div>';
          } else {
            right = formatMoney(r.profit) + '<div class="pct">' + formatPct(r.growth) + '</div>';
          }
          html += '<div class="step-row ' + r.status + (isNext ? " next-step" : "") + '">' +
            '<div class="step-num">' + r.step + '</div>' +
            '<div class="step-body"><div class="step-main">' + badge + " " + formatMoney(r.end) +
            '</div><div class="step-meta">' + (r.date || "—") + '</div></div>' +
            '<div class="step-right">' + right + '</div></div>';
        });
      }
      html += '</div>'; // year-plan-box

      // Button to create NEXT year — outside gray box, after this year section
      const nextY = y + 1;
      if (y === maxYear) {
        html += '<div class="year-next-btn-wrap">' +
          '<button class="btn btn-secondary btn-add-year" data-year="' + nextY + '">Создать план на ' + nextY + '</button>' +
          '</div>';
      }
      html += '</div>'; // year-section
    });
    list.innerHTML = html;

    list.querySelectorAll(".btn-close-row").forEach(btn => {
      btn.addEventListener("click", e => { e.stopPropagation(); closeStep(Number(btn.dataset.step)); });
    });
    list.querySelectorAll(".btn-undo").forEach(btn => {
      btn.addEventListener("click", e => { e.stopPropagation(); undoLastStep(Number(btn.dataset.step)); });
    });
    list.querySelectorAll(".btn-add-year").forEach(btn => {
      btn.addEventListener("click", () => {
        const y = Number(btn.dataset.year);
        state.planYear = y;
        saveData(state);
        haptic("medium");
        render();
        if (tg?.showAlert) tg.showAlert("Добавлен план на " + y + " год");
      });
    });
  }
}

function switchTab(tab) {
  document.querySelectorAll(".tab-page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("tab-" + tab).classList.add("active");
  document.querySelector('.nav-btn[data-tab="' + tab + '"]').classList.add("active");
  window.scrollTo(0, 0);
  haptic("light");
  if (tab === "capital") setTimeout(render, 40);
}

function closeStep(stepNum) {
  const model = buildModel(state);
  if (!stepNum) stepNum = model.nextStep;
  if (stepNum !== model.nextStep) return alert("Сначала закрой предыдущие шаги");
  if (state.closed.some(c => c.step === stepNum)) return alert("Уже закрыт");

  state.closed.push({ step: stepNum, date: todayISO() });
  state.closed.sort((a, b) => a.step - b.step);
  state.avgDaysBetweenSteps = calcAvgDays(state.closed);
  saveData(state);
  haptic("medium");
  render();
  if (tg?.showPopup) {
    tg.showPopup({
      title: "Шаг " + stepNum + " закрыт",
      message: "Если нажали случайно — в списке у этого шага есть «Отменить»",
      buttons: [{ type: "ok" }],
    });
  }
}

function undoLastStep(stepNum) {
  const model = buildModel(state);
  if (stepNum !== model.lastStep) {
    return alert("Можно отменить только последний закрытый шаг");
  }
  const doUndo = () => {
    state.closed = state.closed.filter(c => c.step !== stepNum);
    saveData(state);
    haptic("heavy");
    render();
  };
  if (tg?.showConfirm) {
    tg.showConfirm("Отменить закрытие шага " + stepNum + "?", ok => { if (ok) doUndo(); });
  } else if (confirm("Отменить закрытие шага " + stepNum + "?")) doUndo();
}

function addDeposit() {
  const raw = document.getElementById("deposit-input").value;
  const amount = Number(raw);
  if (!raw || isNaN(amount) || amount <= 0) return alert("Введи сумму пополнения");

  state.topUps = state.topUps || [];
  state.topUps.push({ id: uid(), date: todayISO(), amount });
  document.getElementById("deposit-input").value = "";
  saveData(state);
  haptic("medium");
  render();
  if (tg?.showAlert) {
    tg.showAlert("Пополнение +" + formatMoney(amount) + " учтено. % будет с нового капитала.");
  }
}

function createYear2027() {
  state.planYear = 2027;
  saveData(state);
  haptic("medium");
  render();
  if (tg?.showAlert) tg.showAlert("Добавлен блок плана на 2027 год");
}

function saveParams() {
  const start = Number(document.getElementById("param-start").value);
  const pct = Number(document.getElementById("param-pct").value);
  const goal = parseGoalInput(document.getElementById("param-goal").value);
  if (isNaN(start) || start < 0) return alert("Некорректный старт");
  if (isNaN(pct) || pct <= 0 || pct > 100) return alert("% от 0.1 до 100");
  if (isNaN(goal) || goal <= 0) return alert("Некорректная цель");
  state.startCapital = start;
  state.targetPercent = pct;
  state.goal = goal;
  saveData(state);
  haptic("light");
  render();
  if (tg?.showAlert) tg.showAlert("Сохранено");
}

async function init() {
  if (tg) {
    tg.ready(); tg.expand();
    try { if (typeof tg.disableVerticalSwipes === "function") tg.disableVerticalSwipes(); } catch (_) {}
    try { tg.setHeaderColor("secondary_bg_color"); tg.setBackgroundColor("bg_color"); } catch (_) {}
  }

  state = await loadData();
  if (!state.closed) state.closed = [];
  if (!state.topUps) state.topUps = [];
  if (!state.planYear) state.planYear = 2026;
  // migrate old deposit-on-step format
  if (state.closed.some(c => c.deposit)) {
    state.closed.forEach(c => {
      if (c.deposit) {
        state.topUps.push({ id: uid(), date: c.date || todayISO(), amount: Number(c.deposit) || 0 });
        delete c.deposit;
      }
    });
  }
  if (state.targetPercent > 0 && state.targetPercent <= 1) state.targetPercent *= 100;

  render();

  document.getElementById("param-goal").addEventListener("input", (e) => {
    const raw = e.target.value.replace(/[^\d]/g, "");
    e.target.value = raw ? formatIntSpaces(Number(raw)) : "";
  });

  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  document.getElementById("btn-save-params").addEventListener("click", saveParams);

  let moneyMode = "deposit";
  const cashModal = document.getElementById("cash-modal");
  const moneyInput = document.getElementById("money-input");

  function openCashModal() {
    moneyMode = "deposit";
    document.querySelectorAll(".cash-mode").forEach(b => {
      b.classList.toggle("active", b.dataset.mode === "deposit");
    });
    document.getElementById("money-form-hint").textContent =
      "Сумма добавится сегодня. % со следующего шага — от нового капитала.";
    moneyInput.value = "";
    cashModal.classList.remove("hidden");
    cashModal.setAttribute("aria-hidden", "false");
    setTimeout(() => moneyInput.focus(), 120);
  }
  function closeCashModal() {
    cashModal.classList.add("hidden");
    cashModal.setAttribute("aria-hidden", "true");
    moneyInput.value = "";
    moneyInput.blur();
  }

  document.getElementById("btn-cash").addEventListener("click", openCashModal);
  document.getElementById("cash-modal-backdrop").addEventListener("click", closeCashModal);
  document.getElementById("btn-money-cancel").addEventListener("click", closeCashModal);

  document.querySelectorAll(".cash-mode").forEach(btn => {
    btn.addEventListener("click", () => {
      moneyMode = btn.dataset.mode;
      document.querySelectorAll(".cash-mode").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("money-form-hint").textContent = moneyMode === "deposit"
        ? "Сумма добавится сегодня. % со следующего шага — от нового капитала."
        : "Сумма спишется с капитала сегодня.";
    });
  });

  document.getElementById("btn-money-confirm").addEventListener("click", () => {
    const amount = Number(moneyInput.value);
    if (!moneyInput.value || isNaN(amount) || amount <= 0) return alert("Введи сумму");
    if (moneyMode === "withdraw") {
      const model = buildModel(state);
      if (amount > model.current) return alert("Нельзя вывести больше текущего капитала");
      state.topUps = state.topUps || [];
      state.topUps.push({ id: uid(), date: todayISO(), amount: -amount });
    } else {
      state.topUps = state.topUps || [];
      state.topUps.push({ id: uid(), date: todayISO(), amount: amount });
    }
    closeCashModal();
    saveData(state);
    haptic("medium");
    render();
    if (tg?.showAlert) {
      tg.showAlert(moneyMode === "deposit"
        ? ("Пополнение +" + formatMoney(amount))
        : ("Вывод −" + formatMoney(amount)));
    }
  });

  document.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      currentFilter = chip.dataset.filter;
      render();
    });
  });

  window.addEventListener("resize", () => { if (state) drawChart(buildModel(state)); });
}

init();
