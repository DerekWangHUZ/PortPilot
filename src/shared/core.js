/* PortPilot 核心：唯一的状态与操作入口，所有页面都从这里取事实 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./util.js'), require('./model.js'), require('./state.js'),
      require('./payload.js'), require('./vergetpl.js'), require('./api.js'), require('./log.js'));
  } else {
    root.PP = root.PP || {};
    root.PP.core = factory(root.PP.util, root.PP.model, root.PP.state, root.PP.payload,
      root.PP.vergetpl, root.PP.api, root.PP.log);
  }
})(typeof self !== 'undefined' ? self : this, function (util, model, stateMod, payloadMod, vergetpl, apiMod, logMod) {
  'use strict';

  var STATUS = {
    ON: 'on',
    OFF: 'off',
    FAILED: 'failed',
    PENDING: 'pending'
  };

  var STATUS_TEXT = {
    on: '已开放',
    off: '已关闭',
    failed: '打开失败',
    pending: '正在打开'
  };

  function createIo(bridge) {
    return {
      readText: function (p) { return bridge.invoke('file.read', { path: p }).then(function (r) { return r.text; }); },
      writeText: function (p, t) { return bridge.invoke('file.write', { path: p, text: t }); },
      writeTextAtomic: function (p, t) { return bridge.invoke('file.writeAtomic', { path: p, text: t }); },
      copyFile: function (from, to) { return bridge.invoke('file.copyRaw', { from: from, to: to }); },
      exists: function (p) { return bridge.invoke('file.exists', { path: p }).then(function (r) { return !!r.exists; }); },
      ensureDir: function (p) { return bridge.invoke('file.ensureDir', { path: p }); },
      listFiles: function (p) { return bridge.invoke('file.listFiles', { path: p }).then(function (r) { return r.files || []; }); },
      listDirs: function (p) { return bridge.invoke('file.listDirs', { path: p }).then(function (r) { return r.dirs || []; }); },
      stat: function (p) { return bridge.invoke('file.stat', { path: p }); }
    };
  }

  function createCore(deps) {
    var bridge = deps.bridge;
    var io = createIo(bridge);
    var listeners = [];

    var core = {
      STATUS: STATUS,
      bridge: bridge,
      io: io,
      paths: null,
      app: null,
      store: null,
      api: null,
      runLog: null,
      state: stateMod.defaultState(),
      core_: { ok: false, version: null, pipe: null, error: '', configs: null },
      vergeRunning: false,
      nodes: [],
      proxies: {},
      groupNow: {},
      runtime: {},
      connections: null,
      rules: [],
      busy: false,
      lastError: '',
      lastGoodPayload: null
    };

    /* --------------------------------------------------------------- 事件 */
    core.on = function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); };
    function emit(name, payload) {
      (listeners[name] || []).forEach(function (fn) {
        try { fn(payload); } catch (e) { }
      });
    }
    core.emit = emit;

    /* --------------------------------------------------------------- 启动 */
    core.boot = function () {
      return bridge.invoke('app.info').then(function (info) {
        core.app = info;
        core.paths = {
          appDataDir: info.appDataDir,
          backupDir: info.backupDir,
          stateFile: info.stateFile,
          runLogFile: info.runLogFile,
          vergeDir: info.vergeDir,
          clashConfigPath: info.clashConfigPath,
          profilesYamlPath: info.profilesYamlPath,
          profilesDir: info.profilesDir
        };
        core.store = stateMod.createStore(io, core.paths.stateFile);
        core.runLog = logMod.createLog(io, core.paths.runLogFile);
        core.api = apiMod.createApi(bridge);
        return core.store.load();
      }).then(function (st) {
        core.state = st;
        return core.refresh();
      });
    };

    /* ----------------------------------------------------- 探测：Clash Verge */
    core.probeCore = function () {
      return bridge.invoke('pipe.status').then(function (info) {
        core.core_.ok = !!info.core;
        core.core_.pipe = info.pipe || null;
        core.core_.error = info.error || '';
        core.core_.version = null;
        core.vergeRunning = !!core.app.vergeRunning;
        if (info.version) {
          var parsed = util.safeJson(info.version, null);
          if (parsed && parsed.version) core.core_.version = parsed.version;
        }
        return core.core_;
      });
    };

    core.corePorts = function () {
      var cfg = core.core_.configs;
      if (!cfg) return [];
      var keys = ['mixed-port', 'socks-port', 'port', 'redir-port', 'tproxy-port'];
      var out = [];
      keys.forEach(function (k) {
        var v = parseInt(cfg[k], 10);
        if (util.isValidPort(v)) out.push(v);
      });
      return out;
    };

    core.probePorts = function () {
      var wanted = core.state.ports.map(function (p) { return p.port; });
      if (!wanted.length) { core.runtime = {}; return Promise.resolve({}); }
      return bridge.invoke('net.probe', { ports: wanted }).then(function (res) {
        var map = {};
        (res.results || []).forEach(function (item) { map[item.port] = item; });
        core.runtime = map;
        return map;
      });
    };

    core.refresh = function (opts) {
      opts = opts || {};
      return core.probeCore().then(function () {
        if (!core.core_.ok) {
          core.nodes = [];
          core.proxies = {};
          core.core_.configs = null;
          return core.probePorts();
        }
        return core.api.configs().then(function (cfg) {
          core.core_.configs = cfg;
        }, function () { core.core_.configs = null; })
          .then(function () { return core.api.proxies(); })
          .then(function (map) {
            core.proxies = map;
            core.nodes = [];
            Object.keys(map).forEach(function (name) {
              var proxy = map[name];
              if (!util.isNodeCandidate(proxy)) return;
              core.nodes.push({
                name: proxy.name || name,
                type: proxy.type || '',
                delay: util.lastDelay(proxy),
                alive: proxy.alive !== false
              });
            });
            core.nodes.sort(function (a, b) {
              var da = a.delay === null ? 999999 : a.delay;
              var db = b.delay === null ? 999999 : b.delay;
              if (da !== db) return da - db;
              return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
            });
          }, function () { core.nodes = []; core.proxies = {}; })
          .then(function () { return core.loadGroupStates(); })
          .then(function () { return core.probePorts(); });
      }).then(function () {
        if (opts.withConnections) return core.loadConnections().then(function () { }, function () { });
        return null;
      }).then(function () {
        emit('state', core.view());
        return core.view();
      });
    };

    /* 读取每个端口所属组当前选中的节点（用于「已保存」判定） */
    core.loadGroupStates = function () {
      if (!core.core_.ok) { core.groupNow = {}; return Promise.resolve({}); }
      var chain = Promise.resolve();
      core.state.ports.forEach(function (p) {
        var group = model.groupName(p.port);
        chain = chain.then(function () {
          return core.api.proxyState(group).then(function (st) {
            core.groupNow[p.port] = st.now || null;
          }, function () {
            delete core.groupNow[p.port];
          });
        });
      });
      return chain;
    };

    core.loadConnections = function () {      return core.api.connections().then(function (data) {
        core.connections = data;
        return data;
      });
    };

    core.loadRules = function () {
      return core.api.rules().then(function (rules) {
        core.rules = rules || [];
        return core.rules;
      });
    };

    /* ---------------------------------------------------- 单一事实：端口视图 */
    core.nodeExists = function (name) {
      if (!name) return false;
      return !!core.proxies[name];
    };

    core.portView = function (p) {
      var rt = core.runtime[p.port] || {};
      var status;
      var detail = '';
      if (!p.enabled) {
        status = STATUS.OFF;
      } else if (rt.listening) {
        status = STATUS.ON;
      } else if (!core.core_.ok) {
        status = STATUS.FAILED;
        detail = 'Clash Verge 未运行';
      } else {
        status = STATUS.FAILED;
        detail = rt.bindable === false ? '端口号被占用' : '端口没有监听';
      }
      return {
        port: p.port,
        enabled: !!p.enabled,
        node: p.node || null,
        group: model.groupName(p.port),
        status: status,
        statusText: STATUS_TEXT[status],
        statusDetail: detail,
        nodeMissing: !!(p.enabled && p.node && !core.nodeExists(p.node)),
        saved: !!(p.node && core.groupNow[p.port] === p.node),
        listening: !!rt.listening,
        bindable: rt.bindable !== false,
        delay: p.node && core.proxies[p.node] ? util.lastDelay(core.proxies[p.node]) : null
      };
    };

    core.view = function () {
      var ports = core.state.ports.map(core.portView);
      return {
        app: core.app,
        paths: core.paths,
        settings: core.state.settings,
        core: {
          ok: core.core_.ok,
          version: core.core_.version,
          pipe: core.core_.pipe,
          error: core.core_.error,
          mixedPort: core.core_.configs ? core.core_.configs['mixed-port'] : null,
          ports: core.corePorts()
        },
        vergeRunning: core.vergeRunning,
        nodes: core.nodes,
        ports: ports,
        busy: core.busy,
        lastError: core.lastError,
        connections: core.connections,
        rules: core.rules
      };
    };

    /* ------------------------------------------------------------ 保存状态 */
    core.save = function () {
      return core.store.save(core.state);
    };

    core.appendLog = function (entry) {
      if (!core.runLog) return Promise.resolve();
      return core.runLog.append(entry).then(function () { }, function () { });
    };

    /* --------------------------------------------------------- 应用（核心） */
    core.applyAll = function (reason) {
      if (core.busy) return Promise.reject(new Error('正在处理上一个操作，请稍候'));
      core.busy = true;
      core.lastError = '';
      emit('busy', true);

      var listenersToWrite;
      var groups;
      var payloadText;
      var previousPayload = core.lastGoodPayload;
      var backupInfo = null;
      return Promise.resolve().then(function () {
        if (!core.core_.ok) throw new Error('Clash Verge 未运行，请先启动它');
        listenersToWrite = model.buildListeners(core.state.ports);
        groups = model.buildGroups(core.state.ports);

        var nodeNames = core.nodes.map(function (n) { return n.name; });
        var check = model.validate(core.state, { corePorts: core.corePorts(), nodeNames: nodeNames });
        if (check.errors.length) throw new Error(check.errors.join('；'));

        return core.api.configs().then(function (cfg) {
          core.core_.configs = cfg;
          return io.readText(core.paths.clashConfigPath);
        });
      }).then(function (configText) {
        payloadText = payloadMod.compose(configText, listenersToWrite, groups);
        // 失败时至少要能退回「没注入任何内容」的原始配置
        if (!previousPayload) previousPayload = configText;
        return core.api.applyPayload(payloadText);
      }).then(function () {
        // 已经落到内核，接着落盘到订阅的扩展模板
        return vergetpl.apply({
          io: io,
          profilesYaml: core.paths.profilesYamlPath,
          profilesDir: core.paths.profilesDir,
          backupDir: core.paths.backupDir,
          stamp: util.nowStamp(),
          listeners: listenersToWrite,
          groups: groups
        });
      }).then(function (info) {
        backupInfo = info;
        core.state.lastBackup = { stamp: util.nowStamp(), backups: info.backups };
        core.lastGoodPayload = payloadText;
        return core.pushSelections();
      }).then(function () {
        return core.probePorts();
      }).then(function () {
        return core.save();
      }).then(function () {
        core.busy = false;
        emit('busy', false);
        var failed = core.state.ports.filter(function (p) {
          var v = core.portView(p);
          return v.enabled && v.status !== STATUS.ON;
        });
        core.appendLog({
          action: reason || '应用端口',
          ok: failed.length === 0,
          detail: failed.length ? ('未成功开放：' + failed.map(function (p) { return p.port; }).join('、')) : '全部正常'
        });
        emit('state', core.view());
        return core.view();
      }, function (err) {
        // 回滚：先还原模板，再把内核退回上一次成功的配置
        var chain = Promise.resolve();
        if (backupInfo && backupInfo.backups) {
          chain = chain.then(function () { return vergetpl.restore(io, backupInfo.backups); });
        }
        if (previousPayload) {
          chain = chain.then(function () { return core.api.applyPayload(previousPayload); }, function () { });
        }
        return chain.then(function () {
          core.busy = false;
          core.lastError = err && err.message ? err.message : String(err);
          emit('busy', false);
          core.appendLog({ action: reason || '应用端口', ok: false, detail: core.lastError });
          emit('state', core.view());
          throw err;
        });
      });
    };

    /* 把每个已打开端口的节点选择推回内核（保证选择是我们要的那个） */
    core.pushSelections = function () {
      var chain = Promise.resolve();
      core.state.ports.forEach(function (p) {
        if (!p.enabled || !p.node) return;
        var group = model.groupName(p.port);
        chain = chain.then(function () {
          return core.api.selectNode(group, p.node).then(function () { }, function () { });
        });
      });
      return chain;
    };

    /* ------------------------------------------------------------- 用户操作 */
    core.setEnabled = function (port, enabled) {
      var target = null;
      core.state.ports.forEach(function (p) { if (p.port === port) target = p; });
      if (!target) return Promise.reject(new Error('找不到端口 ' + port));
      target.enabled = !!enabled;
      return core.applyAll((enabled ? '打开端口 ' : '关闭端口 ') + port);
    };

    core.setAllEnabled = function (enabled) {
      core.state.ports.forEach(function (p) { p.enabled = !!enabled; });
      return core.applyAll(enabled ? '全部打开' : '全部关闭');
    };

    core.addPorts = function (numbers) {
      var added = [];
      var used = {};
      core.state.ports.forEach(function (p) { used[p.port] = true; });
      numbers.forEach(function (n) {
        if (!util.isValidPort(n) || used[n]) return;
        used[n] = true;
        core.state.ports.push({ port: n, enabled: false, node: null });
        added.push(n);
      });
      if (!added.length) return Promise.reject(new Error('没有可以新建的端口号（可能重复或超出范围）'));
      core.state.ports.sort(function (a, b) { return a.port - b.port; });
      return core.save().then(function () {
        core.appendLog({ action: '新建端口', ok: true, detail: added.join('、') });
        emit('state', core.view());
        return added;
      });
    };

    core.removePort = function (port) {
      var before = core.state.ports.length;
      core.state.ports = core.state.ports.filter(function (p) { return p.port !== port; });
      if (core.state.ports.length === before) return Promise.reject(new Error('找不到端口 ' + port));
      return core.applyAll('删除端口 ' + port).then(function (view) {
        core.appendLog({ action: '删除端口', port: port, ok: true, detail: '' });
        return view;
      });
    };

    core.changePort = function (oldPort, newPort) {
      if (!util.isValidPort(newPort)) return Promise.reject(new Error('端口号不合法：' + newPort));
      var dup = core.state.ports.some(function (p) { return p.port === newPort && p.port !== oldPort; });
      if (dup) return Promise.reject(new Error('端口号 ' + newPort + ' 已经存在'));
      var target = null;
      core.state.ports.forEach(function (p) { if (p.port === oldPort) target = p; });
      if (!target) return Promise.reject(new Error('找不到端口 ' + oldPort));
      target.port = newPort;
      core.state.ports.sort(function (a, b) { return a.port - b.port; });
      return core.applyAll('端口 ' + oldPort + ' 改为 ' + newPort);
    };

    core.selectNode = function (port, node) {
      var target = null;
      core.state.ports.forEach(function (p) { if (p.port === port) target = p; });
      if (!target) return Promise.reject(new Error('找不到端口 ' + port));
      var group = model.groupName(port);
      target.node = node;
      var applied = false;
      return core.api.selectNode(group, node).catch(function (err) {
        // 组还没进内核（新建端口从未应用过，内核对不存在的组回 404）：
        // 走一次完整应用把 listeners 与分组建出来，节点选择作为组默认值一起生效
        if (!err || err.status !== 404 || !core.core_.ok) throw err;
        applied = true;
        return core.applyAll('为端口 ' + port + ' 建立分组并选择节点');
      }).then(function () {
        return core.api.proxyState(group);
      }).then(function (st) {
        // 回读到的就是内核当前的选择，直接作为「已保存」的依据
        core.groupNow[target.port] = st.now || node;
        return core.save();
      }).then(function () {
        if (applied) return null; // 完整应用时模板已经写过，不再重复写
        // 让默认值也跟着走：写一次模板（不重载内核）
        return vergetpl.apply({
          io: io,
          profilesYaml: core.paths.profilesYamlPath,
          profilesDir: core.paths.profilesDir,
          backupDir: core.paths.backupDir,
          stamp: util.nowStamp(),
          listeners: model.buildListeners(core.state.ports),
          groups: model.buildGroups(core.state.ports)
        });
      }).then(function () {
        core.appendLog({ action: '选择节点', port: port, node: node, ok: true, detail: '' });
        emit('state', core.view());
        return true;
      }, function (err) {
        // 选择失败时把状态退回去
        target.node = null;
        core.appendLog({ action: '选择节点', port: port, node: node, ok: false, detail: err.message });
        emit('state', core.view());
        throw err;
      });
    };

    core.testPort = function (port) {
      var group = model.groupName(port);
      return core.api.delay(group, core.state.settings.testUrl, 5000).then(function (delay) {
        core.appendLog({ action: '端口测速', port: port, ok: true, detail: delay + ' 毫秒' });
        emit('state', core.view());
        return delay;
      }, function (err) {
        core.appendLog({ action: '端口测速', port: port, ok: false, detail: err.message });
        throw err;
      });
    };

    core.testNode = function (node) {
      return core.api.delay(node, core.state.settings.testUrl, 5000);
    };

    /* 自愈：已打开但没有监听的端口，补一次 */
    core.heal = function (reason) {
      if (core.busy || !core.core_.ok) return Promise.resolve(false);
      var need = core.state.ports.some(function (p) {
        if (!p.enabled) return false;
        var rt = core.runtime[p.port] || {};
        return !rt.listening;
      });
      if (!need) return Promise.resolve(false);
      return core.applyAll(reason || '自动恢复端口').then(function () { return true; }, function () { return false; });
    };

    /* 还原：把端口清空并回滚模板 */
    core.reset = function () {
      if (core.busy) return Promise.reject(new Error('正在处理上一个操作，请稍候'));
      core.busy = true;
      emit('busy', true);
      var backup = core.state.lastBackup;
      core.state.ports = [];
      return core.applyAll('移除全部端口').then(function (view) {
        core.busy = false;
        emit('busy', false);
        return view;
      }, function (err) {
        core.busy = false;
        emit('busy', false);
        throw err;
      });
    };

    core.exportConfig = function () {
      return JSON.stringify(core.state, null, 2) + '\n';
    };

    core.importConfig = function (text) {
      var parsed = util.safeJson(text, null);
      if (!parsed) throw new Error('这不是一份合法的 PortPilot 配置');
      var next = stateMod.normalize(parsed);
      core.state.ports = next.ports;
      core.state.settings = next.settings;
      return core.applyAll('导入配置');
    };

    return core;
  }

  return { createCore: createCore, createIo: createIo, STATUS: STATUS, STATUS_TEXT: STATUS_TEXT };
});
