'use strict';

/*
 * v1.4 回归测试：
 *   1) core.reset 不再被 applyAll 的忙碌守卫拒绝（旧版「移除全部端口并还原」必然报错）；
 *      失败时端口列表从 state.json 恢复，避免界面清空而 state.json 未保存的不一致。
 *   2) core.selectNode 失败回退恢复「之前选中的节点」，而不是抹成 null。
 *   3) probeCore 使用宿主实时返回的 vergeRunning（不再依赖启动时的 app.info 快照）。
 * 复用 core.test.js 的假 bridge 结构。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const coreMod = require('../src/shared/core.js');
const stateMod = require('../src/shared/state.js');
const apiMod = require('../src/shared/api.js');
const logMod = require('../src/shared/log.js');

const PROFILES = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'profiles.sample.yaml'), 'utf8');

function makeCore(opts) {
  opts = opts || {};
  const files = new Map();
  const httpLog = [];
  let putConfigsStatus = opts.putConfigsStatus || 204;
  const groupState = {
    name: 'PortPilot-10801', type: 'Selector',
    now: opts.groupNow || null, all: ['节点A', '节点B']
  };
  let kernelTun = opts.kernelTun || null;

  function routeHttp(args) {
    const p = args.path;
    if (args.method === 'PUT' && p === '/configs') {
      return { status: putConfigsStatus, body: '' };
    }
    if (args.method === 'GET' && p === '/configs') {
      return { status: 200, body: JSON.stringify({ 'mixed-port': 7890, tun: kernelTun }) };
    }
    if (args.method === 'GET' && p === '/proxies') {
      return { status: 200, body: JSON.stringify({ proxies: opts.kernelProxies || {} }) };
    }
    if (args.method === 'GET' && p === '/proxies/PortPilot-10801') {
      return { status: 200, body: JSON.stringify(groupState) };
    }
    if (args.method === 'PUT' && p === '/proxies/PortPilot-10801') {
      const parsed = typeof args.body === 'string' ? JSON.parse(args.body) : (args.body || {});
      groupState.now = parsed.name;
      return { status: 204, body: '' };
    }
    return { status: 404, body: '{"message":"Resource not found"}' };
  }

  const pipeStatusResult = opts.pipeStatus || { core: true, pipe: '\\\\.\\pipe\\mihomo', error: '', version: '{"version":"v1.19.0"}' };

  const bridge = {
    invoke: function (name, args) {
      if (name === 'pipe.http') {
        httpLog.push({ method: args.method, path: args.path, body: args.body });
        return Promise.resolve(routeHttp(args));
      }
      if (name === 'pipe.status') return Promise.resolve(pipeStatusResult);
      if (name === 'net.probe') return Promise.resolve({ results: [] });
      if (name === 'file.read') {
        if (!files.has(args.path)) return Promise.reject(new Error('文件不存在：' + args.path));
        return Promise.resolve({ text: files.get(args.path) });
      }
      if (name === 'file.write' || name === 'file.writeAtomic') {
        files.set(args.path, args.text);
        return Promise.resolve({});
      }
      if (name === 'file.exists') return Promise.resolve({ exists: files.has(args.path) });
      if (name === 'file.copyRaw') {
        files.set(args.to, files.get(args.from) || '');
        return Promise.resolve({});
      }
      if (name === 'file.ensureDir') return Promise.resolve({});
      return Promise.reject(new Error('测试桩没有实现：' + name));
    }
  };

  const core = coreMod.createCore({ bridge: bridge });
  const io = coreMod.createIo(bridge);
  core.paths = {
    appDataDir: '.', backupDir: 'backup', stateFile: 'state.json',
    runLogFile: 'run-log.jsonl', vergeDir: 'verge',
    clashConfigPath: 'clash-verge.yaml', profilesYamlPath: 'profiles.yaml', profilesDir: 'profiles'
  };
  core.store = stateMod.createStore(io, core.paths.stateFile);
  core.runLog = logMod.createLog(io, core.paths.runLogFile);
  core.api = apiMod.createApi(bridge);
  core.io = io;
  core.app = { vergeRunning: true };
  core.core_.ok = true;
  core.core_.configs = { 'mixed-port': 7890, tun: kernelTun };
  core.nodes = [
    { name: '节点A', type: 'ss', delay: 120, alive: true },
    { name: '节点B', type: 'ss', delay: 240, alive: true }
  ];
  core.proxies = { '节点A': { name: '节点A', type: 'ss' }, '节点B': { name: '节点B', type: 'ss' } };
  core.state = stateMod.normalize({ ports: [
    { port: 10801, enabled: true, node: '节点A' },
    { port: 10802, enabled: false, node: null }
  ] });

  files.set('clash-verge.yaml', 'mixed-port: 7890\nmode: rule\n');
  files.set('profiles.yaml', PROFILES);
  files.set('profiles/GroupTemplate.yaml', 'prepend: []\nappend: []\ndelete: []\n');
  files.set('profiles/MergeAA.yaml', 'listeners: []\n');

  return { core: core, files: files, httpLog: httpLog, groupState: groupState,
    setPutConfigsStatus: function (s) { putConfigsStatus = s; } };
}

function appliedConfigsCalls(httpLog) {
  return httpLog.filter(function (c) { return c.method === 'PUT' && c.path === '/configs'; });
}

/* ---------- core.reset ---------- */

test('场景H：reset 不再被忙碌守卫拒绝，端口被清空且内核收到空 listeners 的全量应用', async function () {
  const t = makeCore();

  const view = await t.core.reset();
  assert.ok(view, 'reset 应该成功返回视图');

  assert.strictEqual(t.core.state.ports.length, 0, '端口列表应被清空');
  assert.strictEqual(t.core.busy, false, 'reset 结束后 busy 应该是 false');

  const puts = appliedConfigsCalls(t.httpLog);
  assert.strictEqual(puts.length, 1, '应该恰好有一次全量应用');
  const body0 = puts[0].body;
  const payloadText = typeof body0 === 'string' ? JSON.parse(body0).payload : body0.payload;
  assert.ok(!payloadText.includes('PortPilot-'), 'payload 不应再包含任何 PortPilot 监听器/分组');

  assert.ok(t.files.get('state.json').includes('"ports": []'), 'state.json 应保存空端口列表');
  const logText = t.files.get('run-log.jsonl');
  assert.ok(/移除全部端口.*"ok":true/.test(logText), '运行记录应有成功的还原日志');
});

test('场景I：reset 失败（内核拒绝）时端口列表从 state.json 恢复，不留下「界面空、盘上旧」的状态', async function () {
  const t = makeCore();
  // 先保存一次旧状态（两个端口），让 state.json 里有可恢复的内容
  await t.core.save();
  const savedPorts = JSON.parse(t.files.get('state.json')).ports;
  assert.strictEqual(savedPorts.length, 2);

  // 内核这次拒绝整份应用
  t.setPutConfigsStatus(400);

  await assert.rejects(
    t.core.reset(),
    function () { return true; }
  );

  assert.strictEqual(t.core.state.ports.length, 2, '失败后端口列表应恢复为保存过的 2 个');
  assert.strictEqual(t.core.busy, false, '失败后 busy 也要是 false');
  const logText = t.files.get('run-log.jsonl');
  assert.ok(/移除全部端口.*"ok":false/.test(logText), '运行记录应有失败日志');
});

/* ---------- core.selectNode 回退 ---------- */

test('场景J：selectNode 失败时恢复之前选中的节点（而不是抹成 null）', async function () {
  const t = makeCore();
  t.groupState.now = '节点A';
  // 端口已有节点A；这次改选 B，让 PUT /proxies 回 400
  t.core.state.ports[0].node = '节点A';

  let rejectNext = false;
  const core2 = t.core;
  const realApi = core2.api;
  core2.api = Object.assign({}, realApi, {
    selectNode: function (group, node) {
      if (rejectNext) {
        const err = new Error('proxy error');
        err.status = 400;
        return Promise.reject(err);
      }
      return realApi.selectNode(group, node);
    }
  });

  // 先成功选 B
  rejectNext = false;
  await core2.selectNode(10801, '节点B');
  assert.strictEqual(t.core.state.ports[0].node, '节点B');

  // 再选 A 失败：应恢复到 B，而不是抹成 null
  rejectNext = true;
  await assert.rejects(
    core2.selectNode(10801, '节点A'),
    function (err) { return err.message === 'proxy error'; }
  );
  assert.strictEqual(t.core.state.ports[0].node, '节点B', '失败应恢复到之前选中的节点B');
});

/* ---------- probeCore 实时 vergeRunning ---------- */

test('场景K：probeCore 采用 pipe.status 实时返回的 vergeRunning，不依赖启动快照', async function () {
  const t = makeCore({
    pipeStatus: { core: true, pipe: '\\\\.\\pipe\\mihomo', error: '', version: '{"version":"v1.19.0"}', vergeRunning: false, coreRunning: true }
  });
  t.core.app = { vergeRunning: true }; // 启动时 Verge 还在（旧快照）

  await t.core.probeCore();
  assert.strictEqual(t.core.vergeRunning, false, '应使用宿主实时值 false');
});

test('场景L：旧宿主没有 vergeRunning 字段时回退到 app.info 快照（兼容）', async function () {
  const t = makeCore({
    pipeStatus: { core: true, pipe: '\\\\.\\pipe\\mihomo', error: '', version: '{"version":"v1.19.0"}' }
  });
  t.core.app = { vergeRunning: true };

  await t.core.probeCore();
  assert.strictEqual(t.core.vergeRunning, true, '无实时值时应回退到快照');
});
