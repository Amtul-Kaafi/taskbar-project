'use strict';

const desktop = document.getElementById('desktop');
const taskButtons = document.getElementById('task-buttons');
const startButton = document.getElementById('start-button');
const startMenu = document.getElementById('start-menu');
const startMenuList = document.getElementById('start-menu-list');
const clock = document.getElementById('clock');
const hostBadge = document.getElementById('host-badge');

const windows = new Map();
let nextId = 1;
let topZ = 10;
let activeId = null;

/* ---------- app content ---------- */

function notesBody() {
  const wrap = document.createElement('div');
  const area = document.createElement('textarea');
  area.placeholder = 'Type something...';

  const row = document.createElement('div');
  row.className = 'notes-row';

  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = 'Save';

  const status = document.createElement('span');
  status.className = 'notes-status';
  status.textContent = 'Loading...';

  row.append(save, status);
  wrap.append(area, row);

  // Notes live in DATA_DIR on the server, which is a mounted volume in Docker,
  // so they survive `docker compose down` and come back on the next start.
  fetch('/api/notes')
    .then((res) => res.json())
    .then((notes) => {
      area.value = notes.text || '';
      status.textContent = notes.savedAt
        ? 'Saved ' + new Date(notes.savedAt).toLocaleString()
        : 'Not saved yet';
    })
    .catch(() => { status.textContent = 'Could not load notes'; });

  save.addEventListener('click', () => {
    status.textContent = 'Saving...';
    fetch('/api/notes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: area.value })
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('save failed'))))
      .then((saved) => {
        status.textContent = 'Saved ' + new Date(saved.savedAt).toLocaleString();
      })
      .catch(() => { status.textContent = 'Save failed'; });
  });

  return wrap;
}

function clockBody() {
  const wrap = document.createElement('div');
  const time = document.createElement('div');
  const date = document.createElement('div');
  time.className = 'big-clock';
  date.className = 'big-date';
  wrap.append(time, date);

  const tick = () => {
    const now = new Date();
    time.textContent = now.toLocaleTimeString();
    date.textContent = now.toLocaleDateString(undefined, { dateStyle: 'full' });
  };
  tick();
  const timer = setInterval(tick, 1000);
  wrap.addEventListener('window-closed', () => clearInterval(timer));
  return wrap;
}

function calcBody() {
  const wrap = document.createElement('div');
  const display = document.createElement('input');
  display.className = 'calc-display';
  display.readOnly = true;
  display.value = '0';

  const keys = document.createElement('div');
  keys.className = 'calc-keys';
  const layout = ['7', '8', '9', '/', '4', '5', '6', '*', '1', '2', '3', '-', '0', '.', '=', '+', 'C'];

  let expression = '';
  const render = () => { display.value = expression || '0'; };

  layout.forEach((key) => {
    const button = document.createElement('button');
    button.textContent = key;
    button.addEventListener('click', () => {
      if (key === 'C') {
        expression = '';
      } else if (key === '=') {
        expression = evaluate(expression);
      } else {
        expression += key;
      }
      render();
    });
    keys.appendChild(button);
  });

  wrap.append(display, keys);
  return wrap;
}

// Tiny left-to-right evaluator, so no eval() and no operator surprises.
function evaluate(input) {
  const tokens = input.match(/(\d+\.?\d*|[+\-*/])/g);
  if (!tokens || tokens.length === 0) return '';

  let result = parseFloat(tokens[0]);
  if (Number.isNaN(result)) return 'Error';

  for (let i = 1; i < tokens.length; i += 2) {
    const operator = tokens[i];
    const operand = parseFloat(tokens[i + 1]);
    if (Number.isNaN(operand)) return 'Error';
    if (operator === '+') result += operand;
    else if (operator === '-') result -= operand;
    else if (operator === '*') result *= operand;
    else if (operator === '/') result = operand === 0 ? NaN : result / operand;
  }

  return Number.isFinite(result) ? String(Math.round(result * 1e10) / 1e10) : 'Error';
}

function aboutBody() {
  const wrap = document.createElement('div');
  wrap.innerHTML =
    '<p><strong>Taskbar</strong> &mdash; a desktop-style shell served by a zero-dependency Node.js server.</p>' +
    '<p>Open apps from Start, drag windows by their title bar, and use the taskbar buttons to minimize and restore them.</p>';

  const facts = document.createElement('dl');
  facts.className = 'facts';
  wrap.appendChild(facts);

  // Shows which container answered — handy when requests come through the proxy.
  fetch('/api/config')
    .then((res) => res.json())
    .then((config) => {
      [
        ['Version', config.version],
        ['Served by', config.host],
        ['Node', config.node],
        ['Data dir', config.dataDir],
        ['Title', config.title]
      ].forEach(([label, value]) => {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        facts.append(dt, dd);
      });
    })
    .catch(() => { facts.textContent = 'Could not load server config.'; });

  return wrap;
}

const BODIES = {
  notes: notesBody,
  clock: clockBody,
  calc: calcBody,
  about: aboutBody
};

/* ---------- window management ---------- */

function focusWindow(id) {
  activeId = id;
  windows.forEach((win, key) => {
    const isActive = key === id;
    win.el.classList.toggle('active', isActive);
    win.button.classList.toggle('active', isActive);
  });
  const win = windows.get(id);
  if (win) {
    win.el.style.zIndex = ++topZ;
  }
}

function toggleMinimize(id) {
  const win = windows.get(id);
  if (!win) return;
  const minimized = win.el.classList.toggle('minimized');
  if (minimized && activeId === id) {
    win.button.classList.remove('active');
    activeId = null;
  } else if (!minimized) {
    focusWindow(id);
  }
}

function closeWindow(id) {
  const win = windows.get(id);
  if (!win) return;
  win.body.dispatchEvent(new CustomEvent('window-closed'));
  win.el.remove();
  win.button.remove();
  windows.delete(id);
  if (activeId === id) activeId = null;
}

function makeDraggable(el, handle) {
  handle.addEventListener('mousedown', (event) => {
    if (event.target.tagName === 'BUTTON') return;

    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = el.offsetLeft;
    const startTop = el.offsetTop;

    const onMove = (moveEvent) => {
      const maxLeft = desktop.clientWidth - 80;
      const maxTop = desktop.clientHeight - 40;
      const left = Math.min(Math.max(startLeft + moveEvent.clientX - startX, 0), maxLeft);
      const top = Math.min(Math.max(startTop + moveEvent.clientY - startY, 0), maxTop);
      el.style.left = left + 'px';
      el.style.top = top + 'px';
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function openApp(app) {
  const id = nextId++;
  const offset = (windows.size % 6) * 28;

  const el = document.createElement('div');
  el.className = 'window';
  el.style.left = 60 + offset + 'px';
  el.style.top = 50 + offset + 'px';

  const title = document.createElement('div');
  title.className = 'window-title';
  title.innerHTML =
    '<span>' + app.icon + '</span><span>' + app.name + '</span><span class="spacer"></span>';

  const minimizeBtn = document.createElement('button');
  minimizeBtn.textContent = '—';
  minimizeBtn.title = 'Minimize';
  minimizeBtn.addEventListener('click', () => toggleMinimize(id));

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', () => closeWindow(id));

  title.append(minimizeBtn, closeBtn);

  const body = document.createElement('div');
  body.className = 'window-body';
  body.appendChild((BODIES[app.kind] || aboutBody)());

  el.append(title, body);
  el.addEventListener('mousedown', () => focusWindow(id));
  desktop.appendChild(el);
  makeDraggable(el, title);

  const button = document.createElement('button');
  button.className = 'task-button';
  button.innerHTML = '<span>' + app.icon + '</span><span>' + app.name + '</span>';
  button.addEventListener('click', () => {
    if (activeId === id && !el.classList.contains('minimized')) {
      toggleMinimize(id);
    } else {
      el.classList.remove('minimized');
      focusWindow(id);
    }
  });
  taskButtons.appendChild(button);

  windows.set(id, { el, button, body });
  focusWindow(id);
}

/* ---------- start menu + tray ---------- */

function setStartMenu(open) {
  startMenu.classList.toggle('hidden', !open);
  startButton.setAttribute('aria-expanded', String(open));
}

startButton.addEventListener('click', (event) => {
  event.stopPropagation();
  setStartMenu(startMenu.classList.contains('hidden'));
});

document.addEventListener('click', (event) => {
  if (!startMenu.contains(event.target) && event.target !== startButton) {
    setStartMenu(false);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setStartMenu(false);
});

function updateClock() {
  clock.textContent = new Date().toLocaleTimeString();
}
updateClock();
setInterval(updateClock, 1000);

fetch('/api/config')
  .then((res) => res.json())
  .then((config) => {
    document.title = config.title;
    hostBadge.textContent = config.host;
    hostBadge.title = 'Served by ' + config.host;
  })
  .catch(() => { hostBadge.remove(); });

fetch('/api/apps')
  .then((res) => res.json())
  .then((apps) => {
    apps.forEach((app) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.innerHTML = '<span>' + app.icon + '</span><span>' + app.name + '</span>';
      button.addEventListener('click', () => {
        openApp(app);
        setStartMenu(false);
      });
      item.appendChild(button);
      startMenuList.appendChild(item);
    });
  })
  .catch(() => {
    startMenuList.innerHTML = '<li style="padding:8px">Could not load apps.</li>';
  });
