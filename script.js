(() => {
  'use strict';

  /* ---------- Utilitários ---------- */
  const KEY = 'focus-dashboard-v1';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const pad = n => String(n).padStart(2, '0');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const clamp = (v, min, max, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const fmtMin = m => {
    const h = Math.floor(m / 60), r = Math.round(m % 60);
    if (h && r) return `${h} h ${pad(r)} min`;
    if (h) return `${h} h`;
    return `${r} min`;
  };
  const fmtPct = p => (Math.round(p * 10) / 10).toLocaleString('pt-PT', { maximumFractionDigits: 1 });

  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('data-') || k.startsWith('aria-')) e.setAttribute(k, v);
      else e[k] = v;
    }
    kids.forEach(c => e.append(c));
    return e;
  };

  /* ---------- Estado ---------- */
  const defaults = () => ({
    tasks: [],
    activeTaskId: null,
    day: dayKey(),
    sessionsToday: 0,
    focusSeconds: 0,
    milestones: [],
    history: {},
    settings: { name: '', focus: 50, rest: 15, goal: 4, quiet: false, autoNext: false },
    timer: { mode: 'focus', running: false, endAt: 0, remaining: 50 * 60000 }
  });

  function load() {
    const base = defaults();
    try {
      const raw = JSON.parse(localStorage.getItem(KEY));
      if (raw && typeof raw === 'object') {
        return {
          ...base, ...raw,
          settings: { ...base.settings, ...(raw.settings || {}) },
          timer: { ...base.timer, ...(raw.timer || {}) },
          tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
          history: raw.history && typeof raw.history === 'object' ? raw.history : {},
          milestones: Array.isArray(raw.milestones) ? raw.milestones : []
        };
      }
    } catch (_) { /* dados inválidos: começa do zero */ }
    return base;
  }

  const state = load();
  let filter = 'all';
  let editingId = null;
  let lastDeleted = null;
  let audioCtx = null;

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      const d = new Date();
      $('#savedAt').textContent = `Alterações guardadas • ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch (_) {
      $('#savedAt').textContent = 'Não foi possível guardar (armazenamento indisponível)';
    }
  }

  /* Novo dia: mantém tarefas por concluir e reinicia contadores */
  function rollover() {
    const today = dayKey();
    if (state.day === today) return false;
    state.tasks = state.tasks.filter(t => !t.done).map(t => ({ ...t, sessions: 0 }));
    state.sessionsToday = 0;
    state.focusSeconds = 0;
    state.milestones = [];
    state.day = today;
    if (!state.tasks.some(t => t.id === state.activeTaskId)) state.activeTaskId = null;
    const keep = Object.keys(state.history).sort().slice(-60);
    const trimmed = {};
    keep.forEach(k => { trimmed[k] = state.history[k]; });
    state.history = trimmed;
    return true;
  }

  /* ---------- Progresso das tarefas (independente do Pomodoro) ---------- */
  const taskStats = () => {
    const total = state.tasks.length;
    const done = state.tasks.filter(t => t.done).length;
    return { total, done, left: total - done, pct: total ? (done / total) * 100 : 0 };
  };

  /* ---------- Cronómetro ---------- */
  const fullMs = (mode = state.timer.mode) =>
    (mode === 'focus' ? state.settings.focus : state.settings.rest) * 60000;

  const remainingMs = () => {
    const t = state.timer;
    return t.running ? Math.max(0, t.endAt - Date.now()) : t.remaining;
  };

  function ensureAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (_) { audioCtx = null; }
  }

  function beep() {
    if (state.settings.quiet || !audioCtx) return;
    try {
      [0, 0.28, 0.56].forEach(off => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = 740;
        g.gain.setValueAtTime(0.0001, audioCtx.currentTime + off);
        g.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + off + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + off + 0.22);
        o.connect(g).connect(audioCtx.destination);
        o.start(audioCtx.currentTime + off);
        o.stop(audioCtx.currentTime + off + 0.25);
      });
    } catch (_) { /* sem áudio */ }
  }

  function startTimer() {
    const t = state.timer;
    if (t.running) return;
    ensureAudio();
    if (t.remaining <= 0) t.remaining = fullMs();
    t.endAt = Date.now() + t.remaining;
    t.running = true;
    save(); renderTimer(); renderStats();
  }

  function pauseTimer() {
    const t = state.timer;
    if (!t.running) return;
    t.remaining = Math.max(0, t.endAt - Date.now());
    t.running = false;
    save(); renderTimer(); renderStats();
  }

  function resetTimer() {
    const t = state.timer;
    t.running = false;
    t.remaining = fullMs();
    save(); renderTimer(); renderStats();
  }

  function setMode(mode) {
    const t = state.timer;
    t.mode = mode;
    t.running = false;
    t.remaining = fullMs(mode);
    save(); renderTimer(); renderStats();
  }

  function completeSession() {
    const t = state.timer;
    const wasFocus = t.mode === 'focus';
    if (wasFocus) {
      state.sessionsToday += 1;
      state.focusSeconds += state.settings.focus * 60;
      state.history[state.day] = state.sessionsToday;
      const task = state.tasks.find(x => x.id === state.activeTaskId);
      if (task) task.sessions = (task.sessions || 0) + 1;
    }
    beep();
    toast(wasFocus ? 'Sessão de foco concluída. Faz uma pausa.' : 'Descanso terminado. Pronto para focar?');
    t.mode = wasFocus ? 'rest' : 'focus';
    t.remaining = fullMs(t.mode);
    t.running = false;
    if (state.settings.autoNext) {
      t.endAt = Date.now() + t.remaining;
      t.running = true;
    }
    save(); renderAll();
  }

  function tick() {
    if (rollover()) { save(); renderAll(); }
    if (state.timer.running && remainingMs() <= 0) { completeSession(); return; }
    renderTimer();
    renderStats();
  }

  /* ---------- Tarefas ---------- */
  function addTask(title, tag = '', est = 1) {
    title = title.trim();
    if (!title) return;
    state.tasks.push({
      id: uid(), title, tag: tag.trim(),
      est: clamp(est, 1, 12, 1), done: false, sessions: 0, createdAt: Date.now()
    });
    save(); renderAll();
  }

  function updateTask(id, data) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    t.title = data.title.trim() || t.title;
    t.tag = data.tag.trim();
    t.est = clamp(data.est, 1, 12, t.est);
    save(); renderAll();
  }

  function toggleTask(id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    t.done = !t.done;
    if (t.done && state.activeTaskId === id) state.activeTaskId = null;
    save(); renderAll(true);
  }

  function deleteTask(id) {
    const i = state.tasks.findIndex(x => x.id === id);
    if (i < 0) return;
    lastDeleted = { task: state.tasks[i], index: i, wasActive: state.activeTaskId === id };
    state.tasks.splice(i, 1);
    if (state.activeTaskId === id) state.activeTaskId = null;
    save(); renderAll(true);
    toast('Tarefa eliminada.', {
      label: 'Anular',
      fn: () => {
        if (!lastDeleted) return;
        state.tasks.splice(Math.min(lastDeleted.index, state.tasks.length), 0, lastDeleted.task);
        if (lastDeleted.wasActive) state.activeTaskId = lastDeleted.task.id;
        lastDeleted = null;
        save(); renderAll(true);
      }
    });
  }

  function setActive(id) {
    state.activeTaskId = state.activeTaskId === id ? null : id;
    save(); renderAll();
  }

  /* ---------- Renderização ---------- */
  function renderAll(checkMilestones = false) {
    renderStats();
    renderMilestones(checkMilestones);
    renderTasks();
    renderTimer();
    renderBottom();
    renderHeader();
  }

  function renderHeader() {
    const now = new Date();
    const h = now.getHours();
    const part = h < 12 ? 'Bom dia' : h < 20 ? 'Boa tarde' : 'Boa noite';
    const name = state.settings.name.trim();
    $('#greeting').textContent = name ? `${part}, ${name}.` : `${part}.`;
    $('#today').textContent = now.toLocaleDateString('pt-PT', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
    const initials = name ? name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() : 'F';
    $('#avatar').textContent = initials;
    $('#quietToggle').checked = !!state.settings.quiet;
  }

  function liveFocusSeconds() {
    const t = state.timer;
    let extra = 0;
    if (t.mode === 'focus') extra = Math.max(0, (fullMs() - remainingMs()) / 1000);
    return state.focusSeconds + extra;
  }

  const RING_MINI = 2 * Math.PI * 22;
  const RING_TIMER = 2 * Math.PI * 100;

  function renderStats() {
    const s = taskStats();
    const plannedMin = state.tasks.reduce((a, t) => a + t.est * state.settings.focus, 0);
    $('#statTotal').textContent = pad(s.total);
    $('#statPlanned').textContent = `${fmtMin(plannedMin)} previstos`;
    $('#statDone').textContent = pad(s.done);
    $('#statLeft').textContent = `${s.left} por concluir`;
    $('#statTime').textContent = fmtMin(Math.floor(liveFocusSeconds() / 60));
    $('#statPercent').textContent = `${fmtPct(s.pct)}%`;
    $('#statOf').textContent = `${s.done} de ${s.total} tarefas`;
    const ring = $('#miniRing');
    ring.style.strokeDasharray = RING_MINI;
    ring.style.strokeDashoffset = RING_MINI * (1 - s.pct / 100);

    $('#taskCount').textContent = pad(s.total);
    $('#fAll').textContent = s.total;
    $('#fOpen').textContent = s.left;
    $('#fDone').textContent = s.done;
    const focusing = state.tasks.find(t => t.id === state.activeTaskId && !t.done) ? 1 : 0;
    $('#taskSummary').textContent = `${s.done} concluídas · ${focusing} em foco · ${Math.max(0, s.left - focusing)} a seguir`;

    const t = state.timer;
    const started = t.running || remainingMs() < fullMs();
    const chip = $('#statusChip');
    chip.className = 'chip' + (t.running ? ' live' : started ? ' paused' : '');
    $('#statusText').textContent = t.running ? 'Em execução' : started ? 'Em pausa' : 'Pronto';
  }

  function renderMilestones(announce) {
    const { pct } = taskStats();
    $('#trackFill').style.width = `${pct}%`;
    const reached = [25, 50, 75, 100].filter(m => pct >= m);
    const fresh = reached.filter(m => !state.milestones.includes(m));
    $$('.mark').forEach(mk => {
      const m = Number(mk.dataset.m);
      const on = reached.includes(m);
      mk.classList.toggle('reached', on);
      mk.classList.toggle('pop', announce && fresh.includes(m));
    });
    if (announce && fresh.length) {
      const top = Math.max(...fresh);
      toast(top === 100 ? 'Dia completo! Todas as tarefas concluídas.' : `Marco de ${top}% alcançado. Continua assim.`);
    }
    state.milestones = reached;
    save();
    const next = [25, 50, 75, 100].find(m => pct < m);
    $('#milestoneHint').textContent =
      !state.tasks.length ? 'Adiciona tarefas para começar o dia.'
      : pct >= 100 ? 'Todos os marcos alcançados.'
      : `Próximo marco: ${next}%`;
  }

  function renderTasks() {
    const list = $('#taskList');
    list.replaceChildren();
    let items = state.tasks.slice();
    if (filter === 'open') items = items.filter(t => !t.done);
    if (filter === 'done') items = items.filter(t => t.done);
    items.sort((a, b) => Number(a.done) - Number(b.done));

    if (!items.length) {
      list.append(el('li', { class: 'empty', text: state.tasks.length ? 'Nada para mostrar neste filtro.' : 'Sem tarefas. Adiciona a primeira acima.' }));
      return;
    }

    items.forEach(t => {
      const isActive = t.id === state.activeTaskId && !t.done;
      const li = el('li', { class: 'task' + (t.done ? ' done' : '') + (isActive ? ' active' : ''), 'data-id': t.id });

      const check = el('button', { class: 'check', type: 'button', text: '✓', 'data-act': 'toggle', 'aria-label': t.done ? 'Marcar como por concluir' : 'Marcar como concluída', 'aria-pressed': String(t.done) });

      const meta = el('div', { class: 'task-meta' });
      const bits = [];
      if (t.tag) bits.push(el('span', { text: t.tag }));
      if (isActive) bits.push(el('span', { class: 'on', text: (t.tag ? ' • ' : '') + 'Em foco' }));
      bits.forEach(b => meta.append(b));
      const main = el('div', { class: 'task-main' }, el('div', { class: 'task-title', text: t.title }));
      if (bits.length) main.append(meta);

      const sessions = el('span', { class: 'task-sessions', text: `${t.sessions || 0} / ${t.est}`, title: 'Pomodoros feitos / previstos' });
      const time = el('span', { class: 'task-time', text: `${t.est * state.settings.focus} min` });

      const actions = el('div', { class: 'task-actions' },
        el('button', { class: 'icon-btn' + (isActive ? ' on' : ''), type: 'button', text: '◎', title: isActive ? 'Remover foco' : 'Focar nesta tarefa', 'aria-label': 'Focar nesta tarefa', 'data-act': 'focus', disabled: t.done }),
        el('button', { class: 'icon-btn', type: 'button', text: '✎', title: 'Editar', 'aria-label': 'Editar tarefa', 'data-act': 'edit' }),
        el('button', { class: 'icon-btn', type: 'button', text: '✕', title: 'Eliminar', 'aria-label': 'Eliminar tarefa', 'data-act': 'delete' })
      );

      li.append(check, main, sessions, time, actions);
      list.append(li);
    });
  }

  function renderTimer() {
    const t = state.timer;
    const rem = remainingMs();
    const total = fullMs();
    const secs = Math.ceil(rem / 1000);
    const text = `${pad(Math.floor(secs / 60))}:${pad(secs % 60)}`;
    const isFocus = t.mode === 'focus';

    $('#timerTime').textContent = text;
    $('#timerSub').textContent = `de ${pad(Math.floor(total / 60000))}:00 minutos`;
    $('#timerLabel').textContent = isFocus ? 'TEMPO DE FOCO' : 'TEMPO DE DESCANSO';
    $('.timer').classList.toggle('rest', !isFocus);

    const ring = $('#timerRing');
    ring.style.strokeDasharray = RING_TIMER;
    ring.style.strokeDashoffset = RING_TIMER * (total ? rem / total : 1);

    $$('#modeTabs .seg').forEach(b => b.classList.toggle('active', b.dataset.mode === t.mode));

    const started = t.running || rem < total;
    $('#btnToggle').textContent = t.running ? 'Pausar sessão' : started ? 'Retomar sessão' : (isFocus ? 'Iniciar sessão' : 'Iniciar descanso');

    const chip = $('#pomoChip');
    chip.className = 'chip small' + (t.running ? (isFocus ? ' live' : ' live rest') : started ? ' paused' : '');
    $('#pomoChipText').textContent = t.running ? (isFocus ? 'Em curso' : 'Descanso') : started ? 'Pausado' : 'Pronto';

    document.title = t.running ? `${text} · ${isFocus ? 'Foco' : 'Descanso'} — Focus` : 'Focus Dashboard';

    const task = state.tasks.find(x => x.id === state.activeTaskId && !x.done);
    $('#workTitle').textContent = task ? task.title : 'Sem tarefa em foco';
    $('#workTag').textContent = task ? (task.tag || 'Sem projeto') : 'Escolhe uma tarefa na lista';
    $('#workCount').textContent = task ? `${Math.min((task.sessions || 0) + 1, Math.max(task.est, (task.sessions || 0) + 1))}.ª de ${task.est} sessões` : '';

    $('#nextUp').textContent = isFocus
      ? `A seguir: pausa de ${state.settings.rest} min`
      : `A seguir: foco de ${state.settings.focus} min`;
  }

  function renderBottom() {
    const goal = state.settings.goal;
    const done = state.sessionsToday;
    const pct = Math.min(100, (done / goal) * 100);
    $('#goalDone').textContent = done;
    $('#goalTotal').textContent = goal;
    $('#goalPct').textContent = `${Math.round(pct)}%`;
    $('#goalBar').style.width = `${pct}%`;
    $('#goalMinutes').textContent = `${done * state.settings.focus} de ${goal * state.settings.focus} min · a sessão atual não está incluída`;

    const dots = $('#dots');
    dots.replaceChildren();
    const n = Math.min(Math.max(goal, done), 12);
    for (let i = 0; i < n; i++) dots.append(el('i', { class: i < done ? 'on' : '' }));

    // Semana (últimos 7 dias)
    const grid = $('#weekGrid');
    grid.replaceChildren();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const k = dayKey(d);
      days.push({ k, label: d.toLocaleDateString('pt-PT', { weekday: 'short' }).replace('.', ''), n: k === state.day ? state.sessionsToday : (state.history[k] || 0), today: i === 0 });
    }
    const max = Math.max(goal, ...days.map(d => d.n), 1);
    days.forEach(d => {
      const bar = el('div', { class: 'bar' }, el('div', { class: 'bar-fill', style: `width:${(d.n / max) * 100}%` }));
      grid.append(el('div', { class: 'day' + (d.today ? ' today' : '') },
        el('div', { class: 'day-top' }, el('span', { text: d.label.charAt(0).toUpperCase() + d.label.slice(1) }), el('span', { text: String(d.n) })),
        bar));
    });
    const total = days.reduce((a, d) => a + d.n, 0);
    $('#weekSummary').textContent = `${total} sessões de concentração nos últimos 7 dias.`;
  }

  /* ---------- Toasts ---------- */
  function toast(msg, action) {
    const box = $('#toasts');
    const t = el('div', { class: 'toast' }, el('span', { text: msg }));
    if (action) {
      t.append(el('button', { type: 'button', text: action.label, onclick: () => { action.fn(); t.remove(); } }));
    }
    box.append(t);
    setTimeout(() => t.remove(), action ? 6000 : 3500);
  }

  /* ---------- Diálogos ---------- */
  const taskDialog = $('#taskDialog');
  const settingsDialog = $('#settingsDialog');
  const historyDialog = $('#historyDialog');

  function openTaskDialog(id = null) {
    editingId = id;
    const t = id ? state.tasks.find(x => x.id === id) : null;
    $('#taskDialogTitle').textContent = t ? 'Editar tarefa' : 'Nova tarefa';
    $('#fTitle').value = t ? t.title : '';
    $('#fTag').value = t ? t.tag : '';
    $('#fEst').value = t ? t.est : 1;
    taskDialog.showModal();
    $('#fTitle').focus();
  }

  function openSettings() {
    const s = state.settings;
    $('#sName').value = s.name;
    $('#sFocus').value = s.focus;
    $('#sRest').value = s.rest;
    $('#sGoal').value = s.goal;
    $('#sAuto').checked = s.autoNext;
    settingsDialog.showModal();
  }

  function openHistory() {
    const list = $('#historyList');
    list.replaceChildren();
    const hist = { ...state.history, [state.day]: state.sessionsToday };
    const keys = Object.keys(hist).filter(k => hist[k] > 0).sort().reverse().slice(0, 30);
    if (!keys.length) {
      list.append(el('li', { class: 'muted', text: 'Ainda sem sessões concluídas.' }));
    } else {
      keys.forEach(k => {
        const [y, m, d] = k.split('-').map(Number);
        const label = new Date(y, m - 1, d).toLocaleDateString('pt-PT', { weekday: 'short', day: 'numeric', month: 'short' });
        list.append(el('li', {}, el('span', { text: label }), el('span', { class: 'muted', text: `${hist[k]} pomodoros` })));
      });
    }
    historyDialog.showModal();
  }

  // Fechar ao clicar no fundo
  [taskDialog, settingsDialog, historyDialog].forEach(d =>
    d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  /* ---------- Eventos ---------- */
  $('#btnNew').addEventListener('click', () => openTaskDialog());
  $('#taskCancel').addEventListener('click', () => taskDialog.close());
  $('#taskForm').addEventListener('submit', () => {
    const data = { title: $('#fTitle').value, tag: $('#fTag').value, est: $('#fEst').value };
    if (!data.title.trim()) return;
    if (editingId) updateTask(editingId, data);
    else addTask(data.title, data.tag, data.est);
    editingId = null;
  });

  $('#quickForm').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#quickInput');
    addTask(input.value);
    input.value = '';
    input.focus();
  });

  $('#filters').addEventListener('click', e => {
    const b = e.target.closest('.tab');
    if (!b) return;
    filter = b.dataset.filter;
    $$('#filters .tab').forEach(x => x.classList.toggle('active', x === b));
    renderTasks();
  });

  $('#taskList').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.task').dataset.id;
    const act = btn.dataset.act;
    if (act === 'toggle') toggleTask(id);
    else if (act === 'focus') setActive(id);
    else if (act === 'edit') openTaskDialog(id);
    else if (act === 'delete') deleteTask(id);
  });

  $('#btnClearDone').addEventListener('click', () => {
    const n = state.tasks.filter(t => t.done).length;
    if (!n) return toast('Não há tarefas concluídas para limpar.');
    state.tasks = state.tasks.filter(t => !t.done);
    save(); renderAll();
    toast(`${n} tarefa(s) concluída(s) removida(s).`);
  });

  $('#btnToggle').addEventListener('click', () => (state.timer.running ? pauseTimer() : startTimer()));
  $('#btnReset').addEventListener('click', resetTimer);
  $('#btnSkip').addEventListener('click', () => setMode(state.timer.mode === 'focus' ? 'rest' : 'focus'));
  $('#modeTabs').addEventListener('click', e => {
    const b = e.target.closest('.seg');
    if (b && b.dataset.mode !== state.timer.mode) setMode(b.dataset.mode);
  });

  $('#quietToggle').addEventListener('change', e => {
    state.settings.quiet = e.target.checked;
    save();
  });

  $('#btnSettings').addEventListener('click', openSettings);
  $('#settingsCancel').addEventListener('click', () => settingsDialog.close());
  $('#settingsForm').addEventListener('submit', () => {
    const s = state.settings;
    s.name = $('#sName').value.trim();
    s.focus = clamp($('#sFocus').value, 1, 180, s.focus);
    s.rest = clamp($('#sRest').value, 1, 60, s.rest);
    s.goal = clamp($('#sGoal').value, 1, 20, s.goal);
    s.autoNext = $('#sAuto').checked;
    if (!state.timer.running) state.timer.remaining = fullMs();
    save(); renderAll();
  });
  $('#btnWipe').addEventListener('click', () => {
    if (!confirm('Apagar todas as tarefas, estatísticas e definições deste navegador?')) return;
    localStorage.removeItem(KEY);
    location.reload();
  });

  $('#btnHistory').addEventListener('click', openHistory);
  $('#historyClose').addEventListener('click', () => historyDialog.close());

  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('storage', e => {
    if (e.key === KEY) location.reload();
  });

  /* ---------- Arranque ---------- */
  rollover();
  if (state.timer.running && state.timer.endAt <= Date.now()) {
    completeSession();
  } else {
    save();
    renderAll();
  }
  setInterval(tick, 250);
})();
