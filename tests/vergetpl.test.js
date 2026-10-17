const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const util = require('../src/shared/util.js');
const model = require('../src/shared/model.js');
const stateMod = require('../src/shared/state.js');
const vergetpl = require('../src/shared/vergetpl.js');

const PROFILES = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'profiles.sample.yaml'), 'utf8');

function memIo(files) {
  const store = Object.assign({}, files);
  return {
    store,
    exists: (p) => Promise.resolve(Object.prototype.hasOwnProperty.call(store, p)),
    readText: (p) => (store[p] !== undefined ? Promise.resolve(store[p]) : Promise.reject(new Error('缺少文件 ' + p))),
    writeTextAtomic: (p, t) => { store[p] = t; return Promise.resolve(); },
    copyFile: (from, to) => {
      if (store[from] === undefined) return Promise.reject(new Error('缺少文件 ' + from));
      store[to] = store[from];
      return Promise.resolve();
    },
    ensureDir: () => Promise.resolve(),
    listFiles: () => Promise.resolve([]),
    listDirs: () => Promise.resolve([]),
    stat: () => Promise.resolve({})
  };
}

const ROOT = 'C:\\Users\\x\\AppData\\Roaming\\PortPilot';
const PROFILES_DIR = 'C:\\Users\\x\\AppData\\Roaming\\io.github.clash-verge-rev.clash-verge-rev\\profiles';
const PROFILES_YAML = 'C:\\Users\\x\\AppData\\Roaming\\io.github.clash-verge-rev.clash-verge-rev\\profiles.yaml';

function opts(io, listeners, groups) {
  return {
    io,
    profilesYaml: PROFILES_YAML,
    profilesDir: PROFILES_DIR,
    backupDir: ROOT + '\\backup',
    stamp: '20260101-000000',
    listeners,
    groups
  };
}

test('parseProfiles 读出当前订阅与两个模板', () => {
  const parsed = vergetpl.parseProfiles(PROFILES);
  assert.strictEqual(parsed.current, 'RemoteA');
  const item = parsed.items.find((i) => i.uid === 'RemoteA');
  assert.strictEqual(item.type, 'remote');
  assert.strictEqual(item.file, 'RemoteA.yaml');
  assert.strictEqual(item.merge, 'MergeAA');
  assert.strictEqual(item.groups, 'GroupTemplate');
});

test('parseProfiles 把 merge/groups 为 null 当作没有', () => {
  const text = 'current: A\nitems:\n- uid: A\n  type: remote\n  file: A.yaml\n  option:\n    merge: null\n    groups: ~\n';
  const item = vergetpl.parseProfiles(text).items[0];
  assert.strictEqual(item.merge, null);
  assert.strictEqual(item.groups, null);
});

test('setItemOption 会替换已有的 merge 值', () => {
  const next = vergetpl.setItemOption(PROFILES, 'RemoteA', 'merge', 'ppmerge');
  assert.ok(next.includes('    merge: ppmerge'));
  assert.ok(!next.includes('merge: MergeAA'));
  assert.ok(next.includes('    groups: GroupTemplate'));
  assert.ok(next.includes('update_interval: 1440'));
});

test('setItemOption 在没有 option 块时新建一个', () => {
  const text = 'current: A\nitems:\n- uid: A\n  type: remote\n  file: A.yaml\n';
  const next = vergetpl.setItemOption(text, 'A', 'merge', 'ppmerge');
  assert.ok(/option:/.test(next));
  assert.ok(/merge: ppmerge/.test(next));
  const item = vergetpl.parseProfiles(next).items[0];
  assert.strictEqual(item.merge, 'ppmerge');
});

test('setItemOption 不会把内容混进别的订阅', () => {
  const next = vergetpl.setItemOption(PROFILES, 'RemoteA', 'groups', 'ppgroups');
  const parsed = vergetpl.parseProfiles(next);
  const remote = parsed.items.find((i) => i.uid === 'RemoteA');
  const mergeItem = parsed.items.find((i) => i.uid === 'Merge');
  assert.strictEqual(remote.groups, 'ppgroups');
  assert.strictEqual(mergeItem.groups, null);
  assert.strictEqual(parsed.items.length, 4);
});

test('appendItem 在 items 末尾追加一个模板条目', () => {
  const next = vergetpl.appendItem(PROFILES, 'ppmerge', 'merge', 'ppmerge.yaml');
  const parsed = vergetpl.parseProfiles(next);
  assert.strictEqual(parsed.items.length, 5);
  const added = parsed.items[4];
  assert.strictEqual(added.uid, 'ppmerge');
  assert.strictEqual(added.type, 'merge');
  assert.strictEqual(added.file, 'ppmerge.yaml');
});

test('appendItem 在 items 不是最后一个块时拒绝写入', () => {
  const text = 'current: A\nitems:\n- uid: A\n  type: remote\n  file: A.yaml\nother: 1\n';
  assert.throws(() => vergetpl.appendItem(text, 'x', 'merge', 'x.yaml'), /结构不符合预期/);
});

test('apply 写两份模板并留下备份', async () => {
  const io = memIo({
    [PROFILES_YAML]: PROFILES,
    [PROFILES_DIR + '\\MergeAA.yaml']: '# Profile Enhancement Merge Template for Clash Verge\n',
    [PROFILES_DIR + '\\GroupTemplate.yaml']: 'prepend: []\n\nappend: []\n\ndelete: []\n'
  });
  const listeners = model.buildListeners([{ port: 10801, enabled: true, node: '台湾 01' }]);
  const groups = model.buildGroups([{ port: 10801, enabled: true, node: '台湾 01' }]);
  const result = await vergetpl.apply(opts(io, listeners, groups));

  assert.strictEqual(result.mergeFile, 'MergeAA.yaml');
  assert.strictEqual(result.groupsFile, 'GroupTemplate.yaml');
  assert.strictEqual(result.profilesChanged, false);

  const merge = io.store[PROFILES_DIR + '\\MergeAA.yaml'];
  assert.ok(merge.includes('listeners:'));
  assert.ok(merge.includes('- name: "PortPilot-10801"'));
  assert.ok(merge.includes('  proxy: "PortPilot-10801"'));

  const groupsText = io.store[PROFILES_DIR + '\\GroupTemplate.yaml'];
  assert.ok(groupsText.includes('append:'));
  assert.ok(groupsText.includes('- name: "PortPilot-10801"'));
  assert.ok(groupsText.includes('prepend: []'));
  assert.ok(groupsText.includes('delete: []'));

  const backupFiles = Object.keys(io.store).filter((k) => k.indexOf('backup') >= 0);
  assert.strictEqual(backupFiles.length, 2);
});

test('apply 之后可以还原成原样', async () => {
  const original = '# Profile Enhancement Merge Template for Clash Verge\n';
  const io = memIo({
    [PROFILES_YAML]: PROFILES,
    [PROFILES_DIR + '\\MergeAA.yaml']: original,
    [PROFILES_DIR + '\\GroupTemplate.yaml']: 'prepend: []\nappend: []\ndelete: []\n'
  });
  const listeners = model.buildListeners([{ port: 10801, enabled: true, node: '台湾 01' }]);
  const groups = model.buildGroups([{ port: 10801, enabled: true, node: '台湾 01' }]);
  const result = await vergetpl.apply(opts(io, listeners, groups));
  assert.notStrictEqual(io.store[PROFILES_DIR + '\\MergeAA.yaml'], original);

  await vergetpl.restore(io, result.backups);
  assert.strictEqual(io.store[PROFILES_DIR + '\\MergeAA.yaml'], original);
});

test('apply 在缺少 option.merge 时自动新建条目并改 profiles.yaml', async () => {
  const text = 'current: A\nitems:\n- uid: A\n  type: remote\n  file: A.yaml\n  option:\n    update_interval: 1440\n';
  const io = memIo({ [PROFILES_YAML]: text });
  const listeners = model.buildListeners([{ port: 10802, enabled: true, node: '台湾 01' }]);
  const groups = model.buildGroups([{ port: 10802, enabled: true, node: '台湾 01' }]);
  const result = await vergetpl.apply(opts(io, listeners, groups));

  assert.strictEqual(result.profilesChanged, true);
  assert.deepStrictEqual(result.createdItems.sort(), ['ppgroups', 'ppmerge']);
  const parsed = vergetpl.parseProfiles(io.store[PROFILES_YAML]);
  const item = parsed.items.find((i) => i.uid === 'A');
  assert.strictEqual(item.merge, 'ppmerge');
  assert.strictEqual(item.groups, 'ppgroups');
  assert.ok(io.store[PROFILES_DIR + '\\ppmerge.yaml'].includes('listeners:'));
  assert.ok(io.store[PROFILES_DIR + '\\ppgroups.yaml'].includes('append:'));
});

test('apply 用空的 listeners 清掉端口', async () => {
  const io = memIo({
    [PROFILES_YAML]: PROFILES,
    [PROFILES_DIR + '\\MergeAA.yaml']: 'profile:\n  store-selected: true\n',
    [PROFILES_DIR + '\\GroupTemplate.yaml']: 'prepend: []\nappend: []\ndelete: []\n'
  });
  const listeners = model.buildListeners([{ port: 10801, enabled: true, node: '台湾 01' }]);
  const groups = model.buildGroups([{ port: 10801, enabled: true, node: '台湾 01' }]);
  await vergetpl.apply(opts(io, listeners, groups));
  await vergetpl.apply(opts(io, [], []));

  const merge = io.store[PROFILES_DIR + '\\MergeAA.yaml'];
  assert.ok(!/^listeners:$/m.test(merge));
  assert.ok(merge.includes('store-selected: true'));
  const groupsText = io.store[PROFILES_DIR + '\\GroupTemplate.yaml'];
  assert.ok(!groupsText.includes('PortPilot-'));
  assert.ok(groupsText.includes('append:'));
});

test('state.normalize 去重、排序并补默认设置', () => {
  const s = stateMod.normalize({
    ports: [{ port: 10802, enabled: 1, node: 'a' }, { port: 10801 }, { port: 10801 }, { port: 0 }, { port: 'x' }],
    settings: { theme: '乱写' }
  });
  assert.deepStrictEqual(s.ports.map((p) => p.port), [10801, 10802]);
  assert.strictEqual(s.ports[1].enabled, true);
  assert.strictEqual(s.settings.theme, 'system');
  assert.strictEqual(s.settings.testUrl, stateMod.DEFAULT_TEST_URL);
  assert.strictEqual(s.settings.startPort, 10801);
});

test('nextFreePort 从 10801 开始避开已用端口', () => {
  assert.strictEqual(model.nextFreePort([], 10801), 10801);
  assert.strictEqual(model.nextFreePort([{ port: 10801 }, { port: 10802 }], 10801), 10803);
  assert.strictEqual(model.nextFreePort([{ port: 10801 }, { port: 10803 }], 10801), 10802);
});

test('isNodeCandidate 排除策略组与内置项', () => {
  assert.strictEqual(util.isNodeCandidate({ name: '节点选择', type: 'Selector' }), false);
  assert.strictEqual(util.isNodeCandidate({ name: 'DIRECT', type: 'Direct' }), false);
  assert.strictEqual(util.isNodeCandidate({ name: '台湾 01', type: 'ss' }), true);
});
