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
