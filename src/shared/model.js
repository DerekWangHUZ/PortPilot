/* 端口 -> 监听器/组 的模型与渲染（纯函数） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'));
  else { root.PP = root.PP || {}; root.PP.model = factory(root.PP.util); }
})(typeof self !== 'undefined' ? self : this, function (util) {
  'use strict';

  var LISTEN_HOST = '127.0.0.1';
  var NAME_PREFIX = 'PortPilot-';

  function groupName(port) { return NAME_PREFIX + port; }
  function listenerName(port) { return NAME_PREFIX + port; }

  function isOurName(name) { return String(name || '').indexOf(NAME_PREFIX) === 0; }

  /* 已打开的端口 -> listeners 条目 */
  function buildListeners(ports) {
    return (ports || []).filter(function (p) { return !!p.enabled; }).map(function (p) {
      return {
        name: listenerName(p.port),
        type: 'mixed',
        listen: LISTEN_HOST,
        port: p.port,
        proxy: groupName(p.port),
        udp: true
      };
    }).sort(function (a, b) { return a.port - b.port; });
  }

  /* 全部端口 -> 每端口一个 select 组（成员含全部真实节点，并把已选节点放在第一位作为默认值） */
  function buildGroups(ports) {
    return (ports || []).map(function (p) {
      return {
        name: groupName(p.port),
        type: 'select',
        includeAllProxies: true,
        selected: p.node || null
      };
    }).sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
  }

  function renderListenerItem(listener) {
    var lines = [];
    lines.push('- name: ' + util.quote(listener.name));
    lines.push('  type: ' + util.quote(listener.type));
    lines.push('  listen: ' + util.quote(listener.listen));
    lines.push('  port: ' + listener.port);
    lines.push('  proxy: ' + util.quote(listener.proxy));
    if (listener.udp) lines.push('  udp: true');
    return lines;
  }

  function renderListenerItems(listeners) {
    var out = [];
    (listeners || []).forEach(function (l) { out = out.concat(renderListenerItem(l)); });
    return out;
  }

  function renderListenerBlock(listeners) {
    if (!listeners || !listeners.length) return [];
    return ['listeners:'].concat(renderListenerItems(listeners));
  }

  function renderGroupItem(group) {
    var lines = [];
    lines.push('- name: ' + util.quote(group.name));
    lines.push('  type: ' + util.quote(group.type || 'select'));
    if (group.includeAllProxies) lines.push('  include-all-proxies: true');
    if (group.selected) lines.push('  proxies: [' + util.quote(group.selected) + ']');
    return lines;
  }

  function renderGroupItems(groups) {
    var out = [];
    (groups || []).forEach(function (g) { out = out.concat(renderGroupItem(g)); });
    return out;
  }

  /* 校验：返回 { errors: [], warnings: [] }，errors 会阻止写入 */
  function validate(state, ctx) {
    ctx = ctx || {};
    var errors = [];
    var warnings = [];
    var ports = (state && state.ports) || [];
    var used = {};
    var reserved = ctx.corePorts || [];

    ports.forEach(function (p) {
      if (!util.isValidPort(p.port)) {
        errors.push('端口号不合法：' + p.port + '（范围 1-65535）');
        return;
      }
      if (used[p.port]) {
        errors.push('端口号重复：' + p.port);
      }
      used[p.port] = true;
      if (reserved.indexOf(p.port) >= 0) {
        errors.push('端口号 ' + p.port + ' 正被 Clash Verge 自身占用，请换一个');
      }
      if (p.port < 1024) {
        warnings.push('端口号 ' + p.port + ' 属于系统保留范围，可能无法打开');
      }
      if (p.enabled && !p.node) {
        warnings.push('端口 ' + p.port + ' 已经打开，但还没有选节点');
      }
      if (p.node && ctx.nodeNames && ctx.nodeNames.indexOf(p.node) < 0) {
        warnings.push('端口 ' + p.port + ' 的节点「' + p.node + '」不在当前节点列表里，请重新选择');
      }
    });

    return { errors: errors, warnings: warnings };
  }

  /* 生成一个当前没有被占用的端口号（从 10801 起） */
  function nextFreePort(ports, start) {
    var used = {};
    (ports || []).forEach(function (p) { used[p.port] = true; });
    var candidate = start || 10801;
    while (used[candidate] || candidate > 65535) candidate++;
    return candidate;
  }

  return {
    LISTEN_HOST: LISTEN_HOST,
    NAME_PREFIX: NAME_PREFIX,
    groupName: groupName,
    listenerName: listenerName,
    isOurName: isOurName,
    buildListeners: buildListeners,
    buildGroups: buildGroups,
    renderListenerItem: renderListenerItem,
    renderListenerItems: renderListenerItems,
    renderListenerBlock: renderListenerBlock,
    renderGroupItem: renderGroupItem,
    renderGroupItems: renderGroupItems,
    validate: validate,
    nextFreePort: nextFreePort
  };
});
