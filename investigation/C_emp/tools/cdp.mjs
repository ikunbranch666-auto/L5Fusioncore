// Minimal CDP driver for headless Chrome (Node 22 global WebSocket).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export class CDP {
  constructor({ ws, pid, httpPort }) {
    this.ws = ws;
    this.pid = pid;
    this.httpPort = httpPort;
    this._id = 0;
    this._pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data.toString());
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalJs(expr, { awaitPromise = false, returnByValue = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise, returnByValue,
    });
    if (r.exceptionDetails) {
      throw new Error('EVAL ERROR: ' + JSON.stringify(r.exceptionDetails).slice(0, 1000));
    }
    return r.result?.value;
  }

  async screenshot(outPath) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, Buffer.from(r.data, 'base64'));
    return outPath;
  }

  async navigate(url, waitMs = 0) {
    await this.send('Page.navigate', { url });
    if (waitMs) await sleep(waitMs);
  }

  async close() {
    try { await this.send('Browser.close'); } catch {}
    try { process.kill(this.pid); } catch {}
  }

  static async _wsOpen(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    return ws;
  }

  static async boot({ port, userDataDir, url, windowSize = '1280,900' }) {
    mkdirSync(userDataDir, { recursive: true });
    const args = [
      '--headless=new', '--no-sandbox',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      `--window-size=${windowSize}`, '--hide-scrollbars',
      '--force-device-scale-factor=1', '--disable-dev-shm-usage',
      `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
      'about:blank',
    ];
    const proc = spawn(CHROME, args, { stdio: 'ignore' });

    let versionUrl = null;
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        versionUrl = (await res.json()).webSocketDebuggerUrl;
        break;
      } catch {}
    }
    if (!versionUrl) throw new Error('Chrome debug port did not open');

    const browserWs = await CDP._wsOpen(versionUrl);
    const targetId = await new Promise((resolve) => {
      const id = 999;
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data.toString());
        if (m.id === id) { browserWs.removeEventListener('message', onMsg); resolve(m.result.targetId); }
      };
      browserWs.addEventListener('message', onMsg);
      browserWs.send(JSON.stringify({ id, method: 'Target.createTarget', params: { url: 'about:blank' } }));
    });

    let pageWsUrl = null;
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await res.json();
      const t = list.find((x) => x.id === targetId && x.type === 'page');
      if (t && t.webSocketDebuggerUrl) { pageWsUrl = t.webSocketDebuggerUrl; break; }
    }
    browserWs.close();

    const ws = await CDP._wsOpen(pageWsUrl);
    const c = new CDP({ ws, pid: proc.pid, httpPort: port });
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    if (url) await c.navigate(url, 1500);
    return c;
  }
}
