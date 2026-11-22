/*  imu.js  -  AnkleSync: ESP32 + IMU  ->  game controls (Web Serial)
 *
 *  Put this file next to index.html and add, just before </body>, on EVERY page
 *  (index.html, select.html, game1.html, game2.html):
 *
 *      <script src="imu.js"></script>
 *
 *  The ESP32 prints one line per sample:   roll,pitch    (degrees)
 *  Works in Chrome / Edge on desktop (HTTPS such as GitHub Pages, or localhost).
 *
 *  How it controls the games: when an ankle move is detected it fires the same
 *  arrow-key events your games already listen to, so game logic and the
 *  Session Complete report keep working unchanged.
 *      game1.html (Side Runner): inversion -> ArrowLeft,  eversion -> ArrowRight
 *      game2.html (Sky Patrol) : dorsiflexion -> ArrowUp, plantarflexion -> ArrowDown
 *
 *  The IMU sits in a footplate shared by both feet. Pick "Right foot" or "Left foot" in the panel
 *  for each patient: the plate's roll is the same, but inversion/eversion swap sides between feet.
 *  The two "Flip" tick-boxes are a ONE-TIME fix if the sensor is mounted so a direction comes out reversed.
 */
(() => {
  'use strict';

  /* ---------------- settings (localStorage, shared by all pages) ---------------- */
  const STORE = 'anklesync.imu.v1';
  const cfg = {
    enabled: true,
    foot: 'right',     // 'right' | 'left'  - which foot is on the plate right now
    threshold: 12,     // degrees away from neutral that counts as a move
    release: 5,        // degrees: foot must come back inside this before the next move
    cooldown: 300,     // ms minimum between two moves
    flipRoll: false,   // tick if inversion / eversion are swapped
    flipPitch: false,  // tick if dorsi / plantar are swapped
    zeroRoll: 0,
    zeroPitch: 0,
  };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) {}
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch (e) {} };

  /* ---------------- which axis drives which page ---------------- */
  const page = location.pathname.toLowerCase();
  const AXIS = page.includes('game1') ? 'roll' : page.includes('game2') ? 'pitch' : null;
  const KEYS = {
    roll:  { pos: 'ArrowLeft', neg: 'ArrowRight' },   // inversion = left, eversion = right
    pitch: { pos: 'ArrowUp',   neg: 'ArrowDown'  },   // dorsiflexion = up, plantarflexion = down
  };
  const LABEL = {
    roll:  { pos: 'Inversion (LEFT)',      neg: 'Eversion (RIGHT)' },
    pitch: { pos: 'Dorsiflexion (UP)',     neg: 'Plantarflexion (DOWN)' },
  };
  const KEYCODE = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };

  /* ---------------- state ---------------- */
  const S = {
    roll: 0, pitch: 0,      // raw angles from the ESP32
    inv: 0, dor: 0,         // after zero/flip:  inv + = inversion,  dor + = dorsiflexion
    connected: false, opening: false, msg: 'Sensor: not connected',
    err: '',                // last "#ERROR ..." text sent by the ESP32 (wiring problems etc.)
    reader: null, lastRx: 0, last: '-',
  };
  const track = { roll: { armed: true, t: 0 }, pitch: { armed: true, t: 0 } };
  const moveListeners = [];
  let root = null;

  /* ---------------- fire a key press into the game ---------------- */
  function pressKey(key) {
    const make = (type) => {
      const e = new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true });
      Object.defineProperty(e, 'keyCode', { get: () => KEYCODE[key] });
      Object.defineProperty(e, 'which',   { get: () => KEYCODE[key] });
      return e;
    };
    document.body.dispatchEvent(make('keydown'));
    setTimeout(() => document.body.dispatchEvent(make('keyup')), 80);
  }

  /* ---------------- movement detection (threshold + hysteresis) ---------------- */
  function detect(axis, v) {
    const t = track[axis];
    const rel = Math.min(cfg.release, cfg.threshold / 2);
    if (!t.armed) { if (Math.abs(v) < rel) t.armed = true; return; }

    const now = performance.now();
    if (Math.abs(v) < cfg.threshold || now - t.t < cfg.cooldown) return;

    t.armed = false;
    t.t = now;
    const dir = v > 0 ? 'pos' : 'neg';
    S.last = LABEL[axis][dir];
    if (cfg.enabled && axis === AXIS) pressKey(KEYS[axis][dir]);
    moveListeners.forEach(fn => fn({ axis, dir, angle: v, label: S.last }));
  }

  function handleLine(line) {
    if (line.startsWith('#')) {                       // messages from the ESP32
      if (line.startsWith('#ERROR')) S.err = line.slice(1);
      else if (line.startsWith('#READY')) S.err = '';
      render();
      return;
    }
    const m = line.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (!m) return;
    S.err = '';
    S.roll = +m[1];
    S.pitch = +m[2];
    S.lastRx = performance.now();
    // plate roll + = plate's left side goes up. For the RIGHT foot that is inversion; for the LEFT foot it is eversion.
    const side = cfg.foot === 'left' ? -1 : 1;
    S.inv = (S.roll - cfg.zeroRoll) * side * (cfg.flipRoll ? -1 : 1);   // + = inversion
    S.dor = -(S.pitch - cfg.zeroPitch) * (cfg.flipPitch ? -1 : 1);   // + = dorsiflexion
    detect('roll', S.inv);
    detect('pitch', S.dor);
    render();
  }

  /* ---------------- Web Serial ---------------- */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function openPort(port) {
    S.opening = true; S.msg = 'Connecting...'; render();
    try {
      for (let i = 0; i < 6; i++) {                   // previous page may still be releasing the port
        try { await port.open({ baudRate: 115200 }); break; }
        catch (e) { if (i === 5) throw e; await sleep(400); }
      }
      S.connected = true;
      readLoop(port);
    } finally {
      S.opening = false; render();
    }
  }

  async function readLoop(port) {
    const dec = new TextDecoderStream();
    const piped = port.readable.pipeTo(dec.writable).catch(() => {});
    S.reader = dec.readable.getReader();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await S.reader.read();
        if (done) break;
        buf += value;
        let n;
        while ((n = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, n).trim());
          buf = buf.slice(n + 1);
        }
        if (buf.length > 500) buf = '';               // garbage guard
      }
    } catch (e) { /* cable pulled */ }
    S.connected = false;
    S.msg = 'Sensor disconnected - click Connect';
    render();
    try { await piped; await port.close(); } catch (e) {}
  }

  async function connect() {                          // needs a click (browser security rule)
    if (!('serial' in navigator)) return;
    try {
      const port = await navigator.serial.requestPort();
      await openPort(port);
    } catch (e) {
      S.msg = 'Sensor: not connected'; render();
    }
  }

  async function autoConnect() {                      // re-opens the port you already approved
    if (S.connected || S.opening) return;
    if (!('serial' in navigator)) { S.msg = 'Use Chrome or Edge'; render(); return; }
    try {
      const ports = await navigator.serial.getPorts();
      if (ports.length) await openPort(ports[0]);
    } catch (e) { S.msg = 'Click Connect sensor'; render(); }
  }

  if ('serial' in navigator) {
    navigator.serial.addEventListener('connect', () => autoConnect());
    navigator.serial.addEventListener('disconnect', () => {
      S.connected = false; S.msg = 'Sensor unplugged'; render();
    });
  }
  addEventListener('pagehide', () => { try { S.reader && S.reader.cancel(); } catch (e) {} });

  /* ---------------- small floating panel (bottom-left) ---------------- */
  function buildUI() {
    const style = document.createElement('style');
    style.textContent = `
      #imu{position:fixed;left:12px;bottom:12px;z-index:99999;font:12px/1.45 system-ui,sans-serif;color:#fff}
      #imu .chip{display:inline-flex;gap:8px;align-items:center;padding:6px 12px;border-radius:999px;
        background:rgba(15,10,40,.88);border:1px solid rgba(255,255,255,.3);cursor:pointer}
      #imu .dot{width:9px;height:9px;border-radius:50%;background:#e55}
      #imu.on .dot{background:#4f8}
      #imu .box{display:none;margin-bottom:8px;padding:12px;width:260px;border-radius:14px;
        background:rgba(15,10,40,.94);border:1px solid rgba(255,255,255,.3)}
      #imu.open .box{display:block}
      #imu .row{display:flex;justify-content:space-between;margin-top:8px}
      #imu .bar{position:relative;height:8px;margin-top:4px;border-radius:4px;background:rgba(255,255,255,.18)}
      #imu .bar:before{content:"";position:absolute;left:50%;top:-2px;bottom:-2px;width:2px;background:#fff8}
      #imu .bar i{position:absolute;top:-3px;width:6px;height:14px;margin-left:-3px;border-radius:3px;background:#6ef}
      #imu button{display:block;width:100%;margin-top:8px;padding:6px;border-radius:8px;border:0;
        background:#6ef;color:#102;font-weight:700;cursor:pointer}
      #imu label{display:block;margin-top:8px}
      #imu input[type=range]{width:100%}
    `;
    document.head.appendChild(style);

    root = document.createElement('div');
    root.id = 'imu';
    root.innerHTML = `
      <div class="box">
        <button data-a="connect">Connect sensor</button>
        <div class="row"><span>&#9664; Inversion | Eversion &#9654;</span><b data-v="inv">0</b></div>
        <div class="bar"><i data-m="inv"></i></div>
        <div class="row"><span>&#9664; Dorsi | Plantar &#9654;</span><b data-v="dor">0</b></div>
        <div class="bar"><i data-m="dor"></i></div>
        <div class="row"><span>Last move</span><b data-v="last">-</b></div>
        <button data-a="zero">Set neutral (zero) now</button>
        <label>Foot on the plate:
          <select data-c="foot" style="width:100%;margin-top:4px;padding:4px;border-radius:6px">
            <option value="right">Right foot</option><option value="left">Left foot</option>
          </select></label>
        <label>Move threshold: <b data-v="th"></b>&deg;<input type="range" min="3" max="40" data-c="threshold"></label>
        <label><input type="checkbox" data-c="flipRoll"> Flip left / right (mounting fix)</label>
        <label><input type="checkbox" data-c="flipPitch"> Flip up / down (mounting fix)</label>
        <label><input type="checkbox" data-c="enabled"> Control the game with the sensor</label>
      </div>
      <div class="chip"><span class="dot"></span><span data-v="status"></span></div>`;
    document.body.appendChild(root);

    // keep panel clicks/keys from starting or steering the game
    ['click', 'mousedown', 'pointerdown', 'touchstart', 'keydown', 'keyup'].forEach(t =>
      root.addEventListener(t, e => e.stopPropagation()));

    root.addEventListener('click', e => {
      const a = e.target.dataset.a;
      if (a === 'connect') connect();
      else if (a === 'zero') { cfg.zeroRoll = S.roll; cfg.zeroPitch = S.pitch; save(); }
      else if (e.target.closest('.chip')) root.classList.toggle('open');
      render();
    });

    root.querySelectorAll('[data-c]').forEach(el => {
      const k = el.dataset.c;
      if (el.type === 'checkbox') el.checked = !!cfg[k]; else el.value = cfg[k];
      el.addEventListener('input', () => {
        cfg[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value;
        save(); render();
      });
    });
  }

  const q = (s) => root.querySelector(s);
  const pos = (v) => Math.max(0, Math.min(100, 50 - (v / 45) * 50)) + '%';   // left = + direction

  function render() {
    if (!root) return;
    const stale = S.connected && performance.now() - S.lastRx > 1500;
    root.classList.toggle('on', S.connected && !stale);
    q('[data-v=status]').textContent =
      S.connected ? (S.err ? S.err : stale ? 'Sensor: connected, no data' : 'Sensor: connected') : S.msg;
    q('[data-a=connect]').style.display = S.connected ? 'none' : 'block';
    if (!root.classList.contains('open')) return;
    q('[data-v=inv]').textContent = S.inv.toFixed(1) + '\u00B0';
    q('[data-v=dor]').textContent = S.dor.toFixed(1) + '\u00B0';
    q('[data-v=last]').textContent = S.last;
    q('[data-v=th]').textContent = cfg.threshold;
    q('[data-m=inv]').style.left = pos(S.inv);
    q('[data-m=dor]').style.left = pos(S.dor);
  }

  /* ---------------- go ---------------- */
  function init() { buildUI(); render(); autoConnect(); setInterval(render, 500); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // handy hooks for later (e.g. record range of motion in the results screen)
  window.AnkleIMU = { state: S, cfg, connect, onMove: (fn) => moveListeners.push(fn) };
})();
