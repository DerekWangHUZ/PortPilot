/* 工具状态：%APPDATA%\PortPilot\state.json */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'));
  else { root.PP = root.PP || {}; root.PP.state = factory(root.PP.util); }
})(typeof self !== 'undefined' ? self : this, function (util) {
  'use strict';

  var DEFAULT_TEST_URL = 'http://cp.cloudflare.com/generate_204';

  function defaultState() {
    return {
      version: 1,
      ports: [],
      settings: {
        theme: 'system',
        testUrl: DEFAULT_TEST_URL,
        watchConfig: true,
        startPort: 10801
      },
      lastBackup: null
    };
  }

  function normalize(input) {
    var base = defaultState();
    var state = input && typeof input === 'object' ? input : {};
    var out = {
      version: 1,
      ports: [],
      settings: base.settings,
      lastBackup: state.lastBackup || null
    };

    var seen = {};
    (state.ports || []).forEach(function (raw) {
      if (!raw) return;
      var port = parseInt(raw.port, 10);
      if (!util.isValidPort(port)) return;
      if (seen[port]) return;
      seen[port] = true;
      out.ports.push({
        port: port,
        enabled: !!raw.enabled,
        node: raw.node ? String(raw.node) : null
      });
    });
    out.ports.sort(function (a, b) { return a.port - b.port; });

    var settings = state.settings || {};
    out.settings = {
      theme: ['system', 'light', 'dark'].indexOf(settings.theme) >= 0 ? settings.theme : 'system',
      testUrl: settings.testUrl ? String(settings.testUrl) : DEFAULT_TEST_URL,
      watchConfig: settings.watchConfig !== false,
      startPort: util.isValidPort(parseInt(settings.startPort, 10)) ? parseInt(settings.startPort, 10) : 10801
    };

    return out;
  }

  /* io: { readText, writeTextAtomic, exists } —— 全部返回 Promise */
  function createStore(io, statePath) {
    return {
      path: statePath,

      load: function () {
        return io.exists(statePath).then(function (yes) {
          if (!yes) return defaultState();
          return io.readText(statePath).then(function (text) {
            var parsed = util.safeJson(text, null);
            if (!parsed) throw new Error('state.json 不是合法的 JSON，请检查或删除它：' + statePath);
            return normalize(parsed);
          });
        });
      },

      save: function (state) {
        var text = JSON.stringify(normalize(state), null, 2) + '\n';
        return io.writeTextAtomic(statePath, text);
      }
    };
  }

  return {
    DEFAULT_TEST_URL: DEFAULT_TEST_URL,
    defaultState: defaultState,
    normalize: normalize,
    createStore: createStore
  };
});
