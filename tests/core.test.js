'use strict';

/*
 * core.selectNode 回归测试（对应 bug：新建端口后选任何节点都报 Resource not found）
 *
 * 根因：addPorts 只写 state.json 不跑 applyAll，PortPilot-<端口> 分组不在内核里；
 * selectNode 第一步 PUT /proxies/PortPilot-<端口> 就被内核回 404（Resource not found）。
 * 修复：404 且内核在线时，自动走一次完整应用（applyAll）把监听器与分组建出来再选择。
 *
 * 场景：
 *   A) 组不在内核（PUT /proxies 回 404）→ 自愈回退，选择成功，内核收到 PUT /configs
 *   B) 组在内核（PUT /proxies 回 204）→ 快路径，不做全量应用，模板照常同步
 *   C) 选择失败（PUT /proxies 回 400）→ 保持原报错，状态回退 node=null
 *
 * 用假 bridge（pipe.http 路由表 + 内存文件）驱动真实的
 * core.js + api.js + vergetpl.js + payload.js + model.js + state.js + log.js。
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
  const files = new Map();          // 内存文件系统：path -> text
  const httpLog = [];               // 内核收到的全部 pipe.http 请求
  const groupState = {              // 内核里 PortPilot-10801 的状态（GET 回读）
    name: 'PortPilot-10801', type: 'Selector',
    now: opts.groupNow || null, all: ['节点A', '节点B']
  };

  function routeHttp(args) {
    const p = args.path;
    if (args.method === 'PUT' && p === '/proxies/PortPilot-10801') {
      if (opts.putGroupStatus >= 200 && opts.putGroupStatus < 300) {
        const parsed = typeof args.body === 'string' ? JSON.parse(args.body) : (args.body || {});
        groupState.now = parsed.name;
        return { status: 204, body: '' };
      }
      return { status: opts.putGroupStatus, body: opts.putGroupBody || '' };
    }
    if (args.method === 'PUT' && p === '/configs') return { status: 204, body: '' };
    if (args.method === 'GET' && p === '/configs') return { status: 200, body: '{"mixed-port":7890}' };
    if (args.method === 'GET' && p === '/proxies') {
      return { status: 200, body: JSON.stringify({ proxies: opts.kernelProxies || {} }) };
    }
    if (args.method === 'GET' && p === '/proxies/PortPilot-10801') {
      return { status: 200, body: JSON.stringify(groupState) };
    }
    return { status: 404, body: '{"message":"Resource not found"}' };
  }

  const bridge = {
    invoke: function (name, args) {
      if (name === 'pipe.http') {
        httpLog.push({ method: args.method, path: args.path, body: args.body });
        return Promise.resolve(routeHttp(args));
      }
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
      if (name === 'file.listFiles') return Promise.resolve({ files: [] });
      if (name === 'file.listDirs') return Promise.resolve({ dirs: [] });
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

  /* 内核在线、节点列表就绪；端口 10801 已新建（关闭状态、从未应用过） */
  core.core_.ok = true;
  core.core_.configs = { 'mixed-port': 7890 };
  core.nodes = [
    { name: '节点A', type: 'ss', delay: 120, alive: true },
    { name: '节点B', type: 'ss', delay: 240, alive: true }
  ];
  core.proxies = { '节点A': { name: '节点A', type: 'ss' }, '节点B': { name: '节点B', type: 'ss' } };
  core.state = stateMod.normalize({ ports: [{ port: 10801, enabled: false, node: null }] });

  files.set('clash-verge.yaml', 'mixed-port: 7890\nmode: rule\n');
  files.set('profiles.yaml', PROFILES);
  files.set('profiles/GroupTemplate.yaml', 'prepend: []\nappend: []\ndelete: []\n');
  files.set('profiles/MergeAA.yaml', 'listeners: []\n');

  return { core: core, files: files, httpLog: httpLog };
}

function appliedConfigsCalls(httpLog) {
  return httpLog.filter(function (c) { return c.method === 'PUT' && c.path === '/configs'; });
}

test('场景A：组不在内核（404）时自动完整应用建立分组，选择成功', async function () {
  const t = makeCore({
    putGroupStatus: 404,
    putGroupBody: '{"message":"Resource not found"}'
  });

  const ok = await t.core.selectNode(10801, '节点A');
  assert.strictEqual(ok, true);

  /* 节点选择已保存，内核回读的 now 也对上了 */
  assert.strictEqual(t.core.state.ports[0].node, '节点A');
  assert.strictEqual(t.core.groupNow[10801], '节点A');

  /* 内核收到了完整应用（PUT /configs），payload 里带这个端口的分组 */
  const puts = appliedConfigsCalls(t.httpLog);
  assert.strictEqual(puts.length, 1, '应该恰好有一次全量应用');
  const body0 = puts[0].body;
  const payloadText = typeof body0 === 'string' ? JSON.parse(body0).payload : body0.payload;
  assert.ok(payloadText.indexOf('PortPilot-10801') >= 0, 'payload 应包含端口分组');

  /* 状态与模板落盘 */
  assert.ok(t.files.get('state.json').indexOf('节点A') >= 0, 'state.json 应保存节点');
  const groupsText = t.files.get('profiles/GroupTemplate.yaml');
  assert.ok(groupsText.indexOf('PortPilot-10801') >= 0, 'groups 模板应包含端口分组');
  assert.ok(groupsText.indexOf('节点A') >= 0, 'groups 模板应把选中节点写成默认值');

  /* 运行记录 */
  const logText = t.files.get('run-log.jsonl');
  assert.ok(/选择节点.*"ok":true/.test(logText), '运行记录应有成功的选择节点日志');
});

test('场景B：组在内核时走快路径，不做全量应用', async function () {
  const t = makeCore({
    putGroupStatus: 204,
    kernelProxies: { 'PortPilot-10801': { name: 'PortPilot-10801', type: 'Selector', now: '节点A' } }
  });

  const ok = await t.core.selectNode(10801, '节点A');
  assert.strictEqual(ok, true);

  assert.strictEqual(t.core.state.ports[0].node, '节点A');
  assert.strictEqual(t.core.groupNow[10801], '节点A');

  /* 快路径：没有任何全量应用 */
  assert.strictEqual(appliedConfigsCalls(t.httpLog).length, 0, '不应触发 PUT /configs');

  /* 模板仍同步一次默认值 */
  const groupsText = t.files.get('profiles/GroupTemplate.yaml');
  assert.ok(groupsText.indexOf('PortPilot-10801') >= 0, 'groups 模板应包含端口分组');
});

test('场景C：内核返回 400 时保持原报错并回退选择', async function () {
  const t = makeCore({
    putGroupStatus: 400,
    putGroupBody: '{"message":"proxy error"}'
  });

  await assert.rejects(
    t.core.selectNode(10801, '节点A'),
    function (err) { return err.message === 'proxy error'; }
  );

  /* 状态回退：node 回到 null，且不落盘 */
  assert.strictEqual(t.core.state.ports[0].node, null);
  assert.strictEqual(t.files.has('state.json'), false);

  const logText = t.files.get('run-log.jsonl');
  assert.ok(/选择节点.*"ok":false/.test(logText), '运行记录应有失败日志');
});
