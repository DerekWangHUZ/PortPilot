/* PortPilot 公共小工具（浏览器与 Node 共用） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.PP = root.PP || {}; root.PP.util = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function formatBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    n = Number(n);
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var i = -1;
    do { n = n / 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i];
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function formatTime(ts) {
    if (!ts) return '—';
    var d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) return '—';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function nowStamp() {
    var d = new Date();
    return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function attr(text) { return escapeHtml(text); }

  /* YAML / JSON 双引号标量：JSON 字符串就是合法的 YAML 双引号标量 */
  function quote(text) {
    return JSON.stringify(text === null || text === undefined ? '' : String(text));
  }

  function unique(list) {
    var seen = {};
    var out = [];
    (list || []).forEach(function (item) {
      var key = String(item);
      if (!seen[key]) { seen[key] = true; out.push(item); }
    });
    return out;
  }

  /* 端口输入解析：支持 10801、10801,10802、10801-10805、换行与空格 */
  function parsePorts(text) {
    var out = [];
    var invalid = [];
    var pieces = String(text || '').split(/[\s,，、;；]+/);
    pieces.forEach(function (piece) {
      if (!piece) return;
      var m = /^(\d+)\s*[-~－]\s*(\d+)$/.exec(piece);
      if (m) {
        var from = parseInt(m[1], 10);
        var to = parseInt(m[2], 10);
        if (from > to) { var t = from; from = to; to = t; }
        if (to - from > 200) { invalid.push(piece); return; }
        for (var p = from; p <= to; p++) out.push(p);
        return;
      }
      if (/^\d+$/.test(piece)) { out.push(parseInt(piece, 10)); return; }
      invalid.push(piece);
    });
    return { ports: unique(out), invalid: invalid };
  }

  function isValidPort(port) {
    return typeof port === 'number' && isFinite(port) && port >= 1 && port <= 65535 &&
      Math.floor(port) === port;
  }

  function isLoopbackGroupName(name) { return /^PortPilot-\d+$/.test(String(name || '')); }

  function groupNameFor(port) { return 'PortPilot-' + port; }

  function isNodeCandidate(proxy) {
    if (!proxy || !proxy.name) return false;
    var t = String(proxy.type || '');
    var excludedTypes = ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay', 'Compatible',
      'Direct', 'Reject', 'RejectDrop', 'Pass', 'Dns', 'Script'];
    if (excludedTypes.indexOf(t) >= 0) return false;
    var excludedNames = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'PASS-RULE', 'COMPATIBLE', 'GLOBAL'];
    if (excludedNames.indexOf(String(proxy.name)) >= 0) return false;
    return true;
  }

  function lastDelay(proxy) {
    if (!proxy) return null;
    var hist = proxy.history;
    if (hist && hist.length) {
      var last = hist[hist.length - 1];
      if (last && typeof last.delay === 'number' && last.delay > 0) return last.delay;
    }
    return null;
  }

  function safeJson(text, fallback) {
    try { return JSON.parse(text); } catch (e) { return fallback; }
  }

  function trimTrailingNewline(text) { return String(text || '').replace(/\r?\n$/, ''); }

  return {
    clone: clone,
    formatBytes: formatBytes,
    formatTime: formatTime,
    nowStamp: nowStamp,
    escapeHtml: escapeHtml,
    attr: attr,
    quote: quote,
    unique: unique,
    parsePorts: parsePorts,
    isValidPort: isValidPort,
    isLoopbackGroupName: isLoopbackGroupName,
    groupNameFor: groupNameFor,
    isNodeCandidate: isNodeCandidate,
    lastDelay: lastDelay,
    safeJson: safeJson,
    trimTrailingNewline: trimTrailingNewline
  };
});
