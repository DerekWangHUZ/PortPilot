/* 运行记录：%APPDATA%\PortPilot\run-log.jsonl */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'));
  else { root.PP = root.PP || {}; root.PP.log = factory(root.PP.util); }
})(typeof self !== 'undefined' ? self : this, function (util) {
  'use strict';

  var MAX_ENTRIES = 800;

  function createLog(io, logPath) {
    function readAll() {
      return io.exists(logPath).then(function (yes) {
        if (!yes) return [];
        return io.readText(logPath).then(function (text) {
          var out = [];
          String(text || '').split(/\r?\n/).forEach(function (line) {
            if (!line.trim()) return;
            var item = util.safeJson(line, null);
            if (item) out.push(item);
          });
          return out;
        });
      });
    }

    return {
      path: logPath,
      read: readAll,
      clear: function () { return io.writeTextAtomic(logPath, ''); },
      append: function (entry) {
        return readAll().then(function (items) {
          items.push({
            time: new Date().toISOString(),
            action: entry.action || '',
            port: entry.port === undefined || entry.port === null ? null : entry.port,
            node: entry.node || null,
            ok: entry.ok !== false,
            detail: entry.detail || ''
          });
          if (items.length > MAX_ENTRIES) items = items.slice(items.length - MAX_ENTRIES);
          var text = items.map(function (i) { return JSON.stringify(i); }).join('\n') + '\n';
          return io.writeTextAtomic(logPath, text).then(function () { return true; });
        });
      }
    };
  }

  return { createLog: createLog, MAX_ENTRIES: MAX_ENTRIES };
});
