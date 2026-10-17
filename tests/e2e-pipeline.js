/*
 * 真机端到端验收：直接走 PortPilot 的配置组装逻辑，验证
 *   1) 能把 listeners + 每端口的分组应用到正在运行的 mihomo
 *   2) 端口真的开始监听
 *   3) 通过端口能代理流量，且走的是选中的节点
 *   4) 关掉之后端口真的停止监听
 * 跑完会把自己改动的部分还原成原样。
 *
 * 用法：node tools/e2e-pipeline.js [端口号]
 */
'use strict';

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const payloadMod = require('../src/shared/payload.js');
const model = require('../src/shared/model.js');

const PORT = parseInt(process.argv[2] || '10801', 10);
const VERGE_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'io.github.clash-verge-rev.clash-verge-rev');
const CONFIG = path.join(VERGE_DIR, 'clash-verge.yaml');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  :: ' + detail : ''));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function discoverPipe() {
  let declared = null;
  const text = fs.readFileSync(CONFIG, 'utf8');
  const m = /^\s*external-controller-pipe:\s*(.+?)\s*$/m.exec(text);
  if (m) declared = m[1].trim().replace(/^['"]|['"]$/g, '');
  const candidates = [];
  if (declared) {
    candidates.push(declared);
    if (declared.includes('sidecar-release-')) candidates.push(declared.replace('sidecar-release-', 'production-'));
    if (declared.includes('production-')) candidates.push(declared.replace('production-', 'sidecar-release-'));
  }
  try {
    fs.readdirSync('\\\\.\\pipe\\').forEach((name) => {
      if (name.toLowerCase().includes('mihomo')) candidates.push('\\\\.\\pipe\\' + name);
    });
  } catch { }
  return [...new Set(candidates)];
}

function httpOn(pipe, method, reqPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('超时')); }, timeoutMs || 20000);
    socket.on('connect', () => {
      const bodyBuf = body === undefined || body === null ? Buffer.alloc(0) : Buffer.from(body, 'utf8');
      let head = `${method} ${reqPath} HTTP/1.1\r\nHost: localhost\r\n`;
      if (bodyBuf.length) head += 'Content-Type: application/json; charset=utf-8\r\n';
      head += `Content-Length: ${bodyBuf.length}\r\nConnection: close\r\n\r\n`;
      socket.write(head);
      if (bodyBuf.length) socket.write(bodyBuf);
    });
    socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
    socket.on('close', () => {
      clearTimeout(timer);
      const sep = buffer.indexOf('\r\n\r\n');
      if (sep < 0) return reject(new Error('响应无法解析'));
      const head = buffer.slice(0, sep).toString('ascii');
      const status = parseInt(head.split(' ')[1], 10);
      const chunked = /transfer-encoding:\s*chunked/i.test(head);
      let bodyBuf = buffer.slice(sep + 4);
      if (chunked) {
        const parts = [];
        let i = 0;
        while (i < bodyBuf.length) {
          const eol = bodyBuf.indexOf('\r\n', i);
          if (eol < 0) break;
          const size = parseInt(bodyBuf.slice(i, eol).toString('ascii').split(';')[0].trim(), 16);
          if (!size) break;
          parts.push(bodyBuf.slice(eol + 2, eol + 2 + size));
          i = eol + 2 + size + 2;
        }
        bodyBuf = Buffer.concat(parts);
      }
      resolve({ status, headers: head, body: bodyBuf.toString('utf8') });
    });
  });
}

async function http(method, reqPath, body, timeoutMs) {
  let lastErr = null;
  for (const candidate of discoverPipe()) {
    try {
      const res = await httpOn(candidate, method, reqPath, body, timeoutMs);
      return { res, pipe: candidate };
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('连不上内核管道');
}

function tcpProbe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(600);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/* 通过 HTTP 代理端口发一个请求，验证真的能代理 */
function proxyGet(port, targetUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const socket = net.connect({ host: '127.0.0.1', port });
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('代理请求超时')); }, 15000);
    socket.on('connect', () => {
      socket.write(`GET ${targetUrl} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: PortPilot-SelfTest\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (c) => { data += c.toString('utf8'); });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
    socket.on('close', () => {
      clearTimeout(timer);
      const status = parseInt((data.split('\r\n')[0] || '').split(' ')[1], 10);
      resolve({ status, head: data.slice(0, 200) });
    });
  });
}

(async function main() {
  console.log('== PortPilot 真机验收 ==');
  let pipe = null;
  let originalText = null;
  let applied = false;

  try {
    originalText = fs.readFileSync(CONFIG, 'utf8');
    check('读取 Clash Verge 运行时配置', originalText.length > 1000, CONFIG + ' (' + originalText.length + ' 字节)');

    const version = await http('GET', '/version');
    pipe = version.pipe;
    check('连上内核管道', version.res.status === 200, pipe);
    check('内核版本', /meta/.test(version.res.body), version.res.body.trim());

    const proxies = JSON.parse((await http('GET', '/proxies')).res.body).proxies;
    const nodes = Object.keys(proxies).filter((n) => {
      const p = proxies[n];
      return p && ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'].indexOf(p.type) < 0 &&
        ['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'GLOBAL'].indexOf(n) < 0;
    });
    check('读到节点列表', nodes.length > 0, nodes.length + ' 个节点');
    const chosen = nodes[0];

    const alreadyListening = await tcpProbe(PORT);
    check('目标端口状态已知', true, alreadyListening
      ? '127.0.0.1:' + PORT + ' 已在监听（当作 PortPilot 已经打开）'
      : '127.0.0.1:' + PORT + ' 当前空闲');

    const state = { ports: [{ port: PORT, enabled: true, node: chosen }] };
    const listeners = model.buildListeners(state.ports);
    const groups = model.buildGroups(state.ports);
    const composed = payloadMod.compose(originalText, listeners, groups);
    check('组装配置文本', composed.includes('listeners:') && composed.includes('PortPilot-' + PORT),
      composed.length + ' 字节');

    const apply = await http('PUT', '/configs', JSON.stringify({ payload: composed }), 30000);
    check('应用配置到内核', apply.res.status >= 200 && apply.res.status < 300,
      'HTTP ' + apply.res.status + ' ' + apply.res.body.slice(0, 160));
    applied = true;
    await sleep(400);

    const listening = await tcpProbe(PORT);
    check('端口开始监听', listening, '127.0.0.1:' + PORT);

    const groupState = JSON.parse((await http('GET', '/proxies/' + encodeURIComponent('PortPilot-' + PORT))).res.body);
    check('端口对应的分组已生效', (groupState.all || []).length > 0,
      '成员 ' + (groupState.all || []).length + ' 个，当前 ' + groupState.now);
    check('默认选中了我们指定的节点', groupState.now === chosen, groupState.now + ' / ' + chosen);

    // 换一个节点（走 PUT /proxies，不重载配置）
    if (nodes.length > 1) {
      const other = nodes[1];
      const sel = await http('PUT', '/proxies/' + encodeURIComponent('PortPilot-' + PORT), JSON.stringify({ name: other }));
      const after = JSON.parse((await http('GET', '/proxies/' + encodeURIComponent('PortPilot-' + PORT))).res.body);
      check('切换节点即时生效', sel.res.status < 300 && after.now === other, after.now);
      await http('PUT', '/proxies/' + encodeURIComponent('PortPilot-' + PORT), JSON.stringify({ name: chosen }));
    }

    const proxied = await proxyGet(PORT, 'http://cp.cloudflare.com/generate_204');
    check('通过端口代理流量', proxied.status === 204, 'HTTP ' + proxied.status + '  ' + proxied.head.split('\r\n')[0]);

    // 用 CONNECT 建一条保持打开的隧道，趁它还在的时候查连接列表
    const tunnel = net.connect({ host: '127.0.0.1', port: PORT });
    await new Promise((resolve, reject) => {
      let head = '';
      const timer = setTimeout(() => reject(new Error('CONNECT 超时')), 12000);
      tunnel.on('connect', () => {
        tunnel.write('CONNECT cp.cloudflare.com:443 HTTP/1.1\r\nHost: cp.cloudflare.com:443\r\n\r\n');
      });
      tunnel.on('data', (c) => {
        head += c.toString('utf8');
        if (head.indexOf('\r\n\r\n') >= 0) {
          clearTimeout(timer);
          check('端口支持 CONNECT 隧道', /^HTTP\/1\.1 200/.test(head), head.split('\r\n')[0]);
          resolve();
        }
      });
      tunnel.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    await sleep(400);
    const conns = JSON.parse((await http('GET', '/connections')).res.body);
    const mine = (conns.connections || []).filter((c) => (c.metadata || {}).inboundName === 'PortPilot-' + PORT);
    const chains = mine.length ? (mine[0].chains || []).join(' → ') : '';
    check('连接被标记到这个端口', mine.length > 0, mine.length + ' 条，链路 ' + chains);
    tunnel.destroy();

    // 关掉：把 listeners 去掉，再应用一次
    const off = payloadMod.compose(originalText, [], []);
    const closeApply = await http('PUT', '/configs', JSON.stringify({ payload: off }), 30000);
    await sleep(400);
    const stillListening = await tcpProbe(PORT);
    check('关闭后端口停止监听', closeApply.res.status < 300 && !stillListening, 'HTTP ' + closeApply.res.status);
  } catch (err) {
    check('验收过程', false, err && err.message ? err.message : String(err));
  } finally {
    try {
      if (applied && originalText) {
        const restore = await http('PUT', '/configs', JSON.stringify({ payload: originalText }), 30000);
        await sleep(300);
        const back = await tcpProbe(PORT);
        check('还原成原配置', restore.res.status < 300,
          'HTTP ' + restore.res.status + (back ? '（原配置里本来就带着这个端口，仍在监听）' : '（已停止监听）'));
      }
    } catch (err) {
      check('还原成原配置', false, err.message);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(failed.length === 0 ? '结果：全部通过（' + results.length + ' 项）'
    : '结果：' + failed.length + ' 项失败 / 共 ' + results.length + ' 项');
  process.exit(failed.length === 0 ? 0 : 1);
})();
