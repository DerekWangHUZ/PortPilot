const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const util = require('../src/shared/util.js');
const model = require('../src/shared/model.js');
const payload = require('../src/shared/payload.js');

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'clash-verge.sample.yaml'), 'utf8');

function listenersFor(ports) {
  return model.buildListeners(ports.map((p) => ({ port: p, enabled: true, node: null })));
}
function groupsFor(pairs) {
  return model.buildGroups(pairs.map(([port, node]) => ({ port, enabled: true, node })));
}

test('parsePorts 支持逗号、范围和空白', () => {
  assert.deepStrictEqual(util.parsePorts('10801,10802').ports, [10801, 10802]);
  assert.deepStrictEqual(util.parsePorts('10801-10803').ports, [10801, 10802, 10803]);
  assert.deepStrictEqual(util.parsePorts('10801 10801\n10802').ports, [10801, 10802]);
  assert.deepStrictEqual(util.parsePorts('abc').invalid, ['abc']);
  assert.deepStrictEqual(util.parsePorts('10801-10805').ports.length, 5);
});

test('buildListeners 只包含已打开的端口', () => {
  const list = model.buildListeners([
    { port: 10801, enabled: true, node: 'x' },
    { port: 10802, enabled: false, node: 'y' }
  ]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'PortPilot-10801');
  assert.strictEqual(list[0].proxy, 'PortPilot-10801');
  assert.strictEqual(list[0].listen, '127.0.0.1');
  assert.strictEqual(list[0].port, 10801);
});

test('buildGroups 把已选节点放在第一位作为默认值', () => {
  const groups = model.buildGroups([{ port: 10801, enabled: true, node: '台湾 01' }]);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].name, 'PortPilot-10801');
  assert.strictEqual(groups[0].includeAllProxies, true);
  assert.strictEqual(groups[0].selected, '台湾 01');
});

test('validate 报出重复端口与内核占用端口', () => {
  const r = model.validate({ ports: [{ port: 7897, enabled: true }, { port: 7897, enabled: false }] },
    { corePorts: [7897], nodeNames: [] });
  assert.ok(r.errors.some((e) => e.includes('正被 Clash Verge 自身占用')));
  assert.ok(r.errors.some((e) => e.includes('端口号重复')));
});

test('validate 提示节点已失效但不阻止', () => {
  const r = model.validate({ ports: [{ port: 10801, enabled: true, node: '不存在的节点' }] },
    { corePorts: [], nodeNames: ['台湾 01'] });
  assert.strictEqual(r.errors.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('不在当前节点列表里')));
});

test('compose 注入监听器与分组，并保持其余内容不变', () => {
  const text = payload.compose(FIXTURE, listenersFor([10801, 10802]), groupsFor([[10801, '台湾 01'], [10802, null]]));
  assert.ok(text.includes('listeners:'));
  assert.ok(text.includes('- name: "PortPilot-10801"'));
  assert.ok(text.includes('  port: 10801'));
  assert.ok(text.includes('  proxy: "PortPilot-10801"'));
  assert.ok(text.includes('  include-all-proxies: true'));
  assert.ok(text.includes('  proxies: ["台湾 01"]'));
  // 原有内容全部保留
  assert.ok(text.includes('mixed-port: 7897'));
  assert.ok(text.includes('- name: 节点选择'));
  assert.ok(text.includes('- MATCH,节点选择'));
  assert.ok(text.includes('external-controller-pipe:'));
});

test('compose 是幂等的：连续两次结果一致', () => {
  const first = payload.compose(FIXTURE, listenersFor([10801]), groupsFor([[10801, '台湾 01']]));
  const second = payload.compose(first, listenersFor([10801]), groupsFor([[10801, '台湾 01']]));
  assert.strictEqual(first, second);
});

test('compose 支持改端口号与改节点而不残留旧内容', () => {
  const first = payload.compose(FIXTURE, listenersFor([10801]), groupsFor([[10801, '台湾 01']]));
  const second = payload.compose(first, listenersFor([10999]), groupsFor([[10999, '🇯🇵 日本 01']]));
  assert.ok(second.includes('port: 10999'));
  assert.ok(!second.includes('port: 10801'));
  assert.ok(second.includes('proxies: ["🇯🇵 日本 01"]'));
  assert.ok(!second.includes('proxies: ["台湾 01"]'));
  assert.strictEqual((second.match(/^listeners:$/gm) || []).length, 1);
});

test('全部端口关闭时不留下空的 listeners 键', () => {
  const on = payload.compose(FIXTURE, listenersFor([10801]), groupsFor([[10801, '台湾 01']]));
  const off = payload.compose(on, [], groupsFor([[10801, '台湾 01']]));
  assert.ok(!/^listeners:$/m.test(off));
  assert.ok(off.includes('- name: "PortPilot-10801"'));
  assert.ok(off.includes('mixed-port: 7897'));
});

test('分组被插到 proxy-groups 之后，且不破坏原有分组', () => {
  const text = payload.compose(FIXTURE, listenersFor([10801]), groupsFor([[10801, '台湾 01']]));
  const lines = text.split('\n');
  const pgIndex = lines.findIndex((l) => l === 'proxy-groups:');
  assert.ok(pgIndex >= 0);
  assert.strictEqual(lines[pgIndex + 1], '# >>> PortPilot');
  assert.ok(lines[pgIndex + 2].startsWith('- name: "PortPilot-10801"'));
  assert.ok(lines.some((l) => l === '- name: 节点选择'));
  assert.ok(lines.some((l) => l === '- name: 自动选择'));
});

test('配置里已有自定义 listeners 时不会覆盖', () => {
  const withForeign = FIXTURE + '\nlisteners:\n- name: someone-else\n  type: mixed\n  port: 12345\n';
  const text = payload.compose(withForeign, listenersFor([10801]), []);
  assert.ok(text.includes('- name: someone-else'));
  assert.ok(text.includes('- name: "PortPilot-10801"'));
  assert.strictEqual((text.match(/^listeners:$/gm) || []).length, 1);
});

test('配置里已经被 Verge 写入了我们的条目时不会重复（注释标记被 YAML 往返丢掉）', () => {
  const regenerated = FIXTURE
    .replace('mode: rule\n',
      'mode: rule\nlisteners:\n- name: PortPilot-10801\n  type: mixed\n  listen: 127.0.0.1\n  port: 10801\n  proxy: PortPilot-10801\n  udp: true\n')
    .replace('proxy-groups:\n',
      'proxy-groups:\n- name: "PortPilot-10801"\n  type: select\n  include-all-proxies: true\n  proxies:\n  - 台湾 01\n');
  assert.ok(regenerated.includes('PortPilot-10801'));

  const text = payload.compose(regenerated, listenersFor([10801]), groupsFor([[10801, '台湾 01']]));
  assert.strictEqual((text.match(/- name: "PortPilot-10801"/g) || []).length, 2, '一个监听器条目 + 一个分组条目');
  assert.strictEqual((text.match(/^listeners:$/gm) || []).length, 1);
  assert.strictEqual((text.match(/- name: 节点选择/) || []).length, 1);
});

test('端口删掉后，Verge 写进配置里的旧条目也会被清掉', () => {
  const regenerated = FIXTURE
    .replace('proxy-groups:\n',
      'proxy-groups:\n- name: "PortPilot-10801"\n  type: select\n  include-all-proxies: true\n- name: "PortPilot-10802"\n  type: select\n  include-all-proxies: true\n');
  const text = payload.compose(regenerated, [], groupsFor([[10802, '台湾 01']]));
  assert.ok(!text.includes('PortPilot-10801'));
  assert.strictEqual((text.match(/PortPilot-10802/g) || []).length, 1);
  assert.ok(!/^listeners:$/m.test(text));
});

test('composeGroupsTemplate 保留 prepend/delete 并只更新 append', () => {
  const template = '# Profile Enhancement Groups Template for Clash Verge\n\nprepend: []\n\nappend: []\n\ndelete: []\n';
  const text = payload.composeGroupsTemplate(template, groupsFor([[10801, '台湾 01']]));
  assert.ok(text.includes('prepend: []'));
  assert.ok(text.includes('delete: []'));
  assert.ok(text.includes('append:'));
  assert.ok(text.includes('- name: "PortPilot-10801"'));

  const again = payload.composeGroupsTemplate(text, groupsFor([[10802, '台湾 01']]));
  assert.ok(!again.includes('PortPilot-10801'));
  assert.strictEqual((again.match(/PortPilot-10802/g) || []).length, 1);
  assert.strictEqual((again.match(/^append:$/gm) || []).length, 1);
});

test('composeGroupsTemplate 会把 PortPilot 之外的 append 条目留下', () => {
  const template = 'prepend: []\nappend:\n- name: 我的组\n  type: select\n  proxies: [DIRECT]\ndelete: []\n';
  const text = payload.composeGroupsTemplate(template, groupsFor([[10801, '台湾 01']]));
  assert.ok(text.includes('- name: 我的组'));
  assert.ok(text.includes('- name: "PortPilot-10801"'));
  const cleaned = payload.composeGroupsTemplate(text, []);
  assert.ok(cleaned.includes('- name: 我的组'));
  assert.ok(!cleaned.includes('PortPilot-'));
});

test('composeGroupsTemplate 反复写入不会堆积空标记', () => {
  const template = 'prepend: []\n\nappend: []\n\ndelete: []\n';
  let text = payload.composeGroupsTemplate(template, groupsFor([[10801, '台湾 01']]));
  for (let i = 0; i < 5; i++) {
    text = payload.composeGroupsTemplate(text, groupsFor([[10801, i % 2 ? '台湾 01' : null]]));
  }
  assert.strictEqual((text.match(/# >>> PortPilot/g) || []).length, 1);
  assert.strictEqual((text.match(/# <<< PortPilot/g) || []).length, 1);
  assert.strictEqual((text.match(/PortPilot-10801/g) || []).length, 1);
});

test('composeListenersOnly 反复写入不会堆积空标记', () => {
  let text = '# Profile Enhancement Merge Template for Clash Verge\n';
  for (let i = 0; i < 4; i++) {
    text = payload.composeListenersOnly(text, listenersFor([10801]));
    text = payload.composeListenersOnly(text, []);
  }
  assert.strictEqual((text.match(/# >>> PortPilot/g) || []).length, 0);
  assert.strictEqual((text.match(/^listeners:$/gm) || []).length, 0);
  assert.ok(text.includes('Profile Enhancement Merge Template'));
});

test('composeListenersOnly 只动 listeners', () => {
  const text = payload.composeListenersOnly('# Merge\n\nprofile:\n  store-selected: true\n', listenersFor([10801]));
  assert.ok(text.includes('profile:'));
  assert.ok(text.includes('store-selected: true'));
  assert.ok(text.includes('listeners:'));
  assert.ok(!text.includes('proxy-groups'));
});

/* ---------- tun 段做平（对应 TUN 兼容修复） ---------- */

const RUNTIME_TUN = {
  enable: true,
  device: 'Mihomo',
  stack: 'mixed',
  'dns-hijack': ['any:53'],
  'auto-route': true,
  'auto-detect-interface': true,
  mtu: 9000,
  gso: false,
  'gso-max-size': 65536,
  'endpoint-independent-nat': false,
  'udp-timeout': 60
};

test('flattenTun 用内核运行值整体覆写配置文本里的 tun 段', () => {
  const text = payload.flattenTun(FIXTURE, RUNTIME_TUN);
  assert.ok(text.includes('tun:'));
  assert.ok(text.includes('  enable: true'));
  assert.ok(text.includes('  device: "Mihomo"'));
  assert.ok(text.includes('  stack: "mixed"'));
  assert.ok(text.includes('  dns-hijack:'));
  assert.ok(text.includes('  - "any:53"'));
  assert.ok(text.includes('  mtu: 9000'));
  assert.ok(text.includes('  gso: false'));
  assert.ok(text.includes('  gso-max-size: 65536'));
  // 原文本里的旧值被替换掉
  assert.ok(!text.includes('stack: gvisor'));
  // 其它内容不受影响
  assert.ok(text.includes('mixed-port: 7897'));
  assert.ok(text.includes('profile:'));
  assert.ok((text.match(/^tun:$/gm) || []).length, 1);
});

test('flattenTun 不在白名单里的键（如 file-descriptor）不会写进配置', () => {
  const text = payload.flattenTun(FIXTURE, { enable: true, 'file-descriptor': 9, 'inet6-address': ['fdfe::/64'] });
  assert.ok(!text.includes('file-descriptor'));
  assert.ok(!text.includes('inet6-address'));
  assert.ok(text.includes('  enable: true'));
});

test('flattenTun 是幂等的：连续两次结果一致', () => {
  const first = payload.flattenTun(FIXTURE, RUNTIME_TUN);
  const second = payload.flattenTun(first, RUNTIME_TUN);
  assert.strictEqual(first, second);
});

test('flattenTun 的输出能被 mihomo 的 tunSchema 键读回（json/yaml 键一致）', () => {
  // 用 flattenTun 产出再次作为输入做平（模拟「应用 → 回读 GET /configs → 再做平」的循环）
  const tunFromKernel = { enable: true, stack: 'system', 'auto-route': true, 'auto-detect-interface': true };
  const once = payload.flattenTun(FIXTURE, tunFromKernel);
  const twice = payload.flattenTun(once, tunFromKernel);
  assert.strictEqual(once, twice);
  assert.ok(twice.includes('  stack: "system"'));
});

test('flattenTun：配置没有 tun 键时新建；空对象/非对象时原样返回', () => {
  const noTun = FIXTURE.replace(/^tun:[\s\S]*?profile:/m, 'profile:');
  assert.ok(!noTun.includes('tun:'));
  const added = payload.flattenTun(noTun, { enable: true, stack: 'gvisor' });
  assert.ok(added.includes('tun:'));
  assert.ok(added.includes('  enable: true'));
  assert.ok(added.includes('  stack: "gvisor"'));

  assert.strictEqual(payload.flattenTun(FIXTURE, null), FIXTURE);
  assert.strictEqual(payload.flattenTun(FIXTURE, undefined), FIXTURE);
  assert.strictEqual(payload.flattenTun(FIXTURE, {}), FIXTURE);
  assert.strictEqual(payload.flattenTun(FIXTURE, [1, 2]), FIXTURE);
});

test('flattenTun：TUN 关闭时也做平 enable:false（阻止误重开）', () => {
  const text = payload.flattenTun(FIXTURE, { enable: false });
  assert.ok(text.includes('  enable: false'));
  // 其它白名单键为空时不会留下旧值
  assert.ok(!text.includes('stack:'));
  assert.ok(!text.includes('auto-route:'));
});

test('compose 接受第 4 参 runtimeTun，第 4 参缺省时行为不变', () => {
  const withTun = payload.compose(FIXTURE, listenersFor([10801]), groupsFor([[10801, '台湾 01']]), RUNTIME_TUN);
  assert.ok(withTun.includes('  device: "Mihomo"'));
  assert.ok(withTun.includes('- name: "PortPilot-10801"'));
  assert.ok(withTun.includes('  include-all-proxies: true'));

  const without = payload.compose(FIXTURE, listenersFor([10801]), groupsFor([[10801, '台湾 01']]));
  assert.ok(without.includes('stack: gvisor'));
  assert.strictEqual(without, payload.compose(FIXTURE, listenersFor([10801]), groupsFor([[10801, '台湾 01']])));
});

test('compose + runtimeTun 是幂等的（真实循环：应用 → Verge 重新生成 → 再应用）', () => {
  const first = payload.compose(FIXTURE, listenersFor([10801]), groupsFor([[10801, '台湾 01']]), RUNTIME_TUN);
  const second = payload.compose(first, listenersFor([10801]), groupsFor([[10801, '台湾 01']]), RUNTIME_TUN);
  assert.strictEqual(first, second);
});
