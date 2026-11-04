/* 配置文本组装：把 listeners / 每端口的组注入到完整配置里，并保证可重复执行（幂等）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./util.js'), require('./yamledit.js'), require('./model.js'));
  } else {
    root.PP = root.PP || {};
    root.PP.payload = factory(root.PP.util, root.PP.yamledit, root.PP.model);
  }
})(typeof self !== 'undefined' ? self : this, function (util, yamledit, model) {
  'use strict';

  var TAG = 'PortPilot';

  function inlineValueOf(keyLine) {
    var idx = keyLine.indexOf(':');
    if (idx < 0) return '';
    return keyLine.slice(idx + 1).trim();
  }

  /* 把关键字行规范成 "key:"（丢掉 [] 之类的空内联值）；有实质内联值时抛错，避免误伤 */
  function normalizeKeyLine(block) {
    var keyLine = block.lines[0];
    var inline = inlineValueOf(keyLine);
    if (inline === '' || inline === '[]' || inline === '{}' || inline === 'null' || inline === '~') {
      block.lines[0] = block.key + ':';
      return true;
    }
    return false;
  }

  function stripOurLines(doc) {
    doc.preamble = yamledit.stripMarked(doc.preamble, TAG);
    doc.blocks.forEach(function (b) { b.lines = yamledit.stripMarked(b.lines, TAG); });
  }

  function bodyIsEmpty(block) {
    return block.lines.slice(1).every(function (l) { return l.trim() === ''; });
  }

  /* 把 listeners 写进文档（没有就新建顶层键） */
  function upsertListeners(doc, listeners) {
    var block = yamledit.findBlock(doc, 'listeners');
    if (block) {
      // Clash Verge 解析模板再序列化时会丢掉注释标记，所以还要按名字清掉我们自己留下的条目
      block.lines = removeOurEntries(block.lines);
      if (bodyIsEmpty(block)) {
        yamledit.removeBlock(doc, 'listeners');
        block = null;
      }
    }
    if (!listeners || !listeners.length) return;
    if (!block) {
      block = { key: 'listeners', lines: ['listeners:'] };
      doc.blocks.push(block);
    }
    if (!normalizeKeyLine(block)) {
      throw new Error('配置里已经有自定义的 listeners 内容，PortPilot 不会覆盖它');
    }
    yamledit.insertIntoSeqBlock(block, model.renderListenerItems(listeners), TAG);
  }

  /* 把每端口的 select 组写进 proxy-groups */
  function upsertGroups(doc, groups) {
    var block = yamledit.findBlock(doc, 'proxy-groups');
    if (block) {
      block.lines = removeOurEntries(block.lines);
    } else {
      if (!groups || !groups.length) return;
      block = { key: 'proxy-groups', lines: ['proxy-groups:'] };
      doc.blocks.push(block);
    }
    if (!groups || !groups.length) return;
    if (!normalizeKeyLine(block)) {
      throw new Error('配置里的 proxy-groups 不是块状列表，PortPilot 无法安全地加入端口分组');
    }
    yamledit.insertIntoSeqBlock(block, model.renderGroupItems(groups), TAG);
  }

  /* GET /configs 返回的 tun 对象里允许写回配置文本的键（与 mihomo LC.Tun 的 yaml/json 键一致） */
  var TUN_KEYS = [
    'enable', 'device', 'stack', 'dns-hijack', 'auto-route', 'auto-detect-interface',
    'auto-redirect', 'mtu', 'gso', 'gso-max-size', 'strict-route',
    'route-address', 'route-exclude-address', 'endpoint-independent-nat',
    'udp-timeout', 'icmp-timeout'
  ];

  function yamlScalar(v) {
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    return util.quote(v);
  }

  function renderTunLines(tun) {
    var lines = [];
    TUN_KEYS.forEach(function (key) {
      var v = tun[key];
      if (v === null || v === undefined) return;
      if (Object.prototype.toString.call(v) === '[object Array]') {
        if (!v.length) { lines.push('  ' + key + ': []'); return; }
        lines.push('  ' + key + ':');
        v.forEach(function (item) { lines.push('  - ' + yamlScalar(item)); });
        return;
      }
      lines.push('  ' + key + ': ' + yamlScalar(v));
    });
    return lines;
  }

  /* 把内核运行时的 tun 值整体做平进配置文本。
     mihomo 每次 PUT /configs 都会执行 ReCreateTun：只有文本解析出的 tun 与运行值完全相等才短路，
     否则拆掉重建 TUN 设备（全局断网抖动，失败时 TUN 被静默关闭）。
     用运行值覆写 tun 段可让 Equal() 恒成立，TUN 完全不动。 */
  function flattenTun(configText, runtimeTun) {
    if (!runtimeTun || typeof runtimeTun !== 'object' ||
        Object.prototype.toString.call(runtimeTun) === '[object Array]') return configText;
    var lines = renderTunLines(runtimeTun);
    if (!lines.length) return configText;
    var doc = yamledit.splitTopLevel(configText);
    var block = yamledit.findBlock(doc, 'tun');
    if (!block) {
      block = { key: 'tun', lines: ['tun:'] };
      doc.blocks.push(block);
    }
    block.lines[0] = 'tun:'; // 内联 flow 风格（tun: {...}）也整体重写为块风格
    yamledit.setBlockBody(block, lines);
    return yamledit.joinTopLevel(doc);
  }

  /* 生成一份完整配置文本（用于 PUT /configs 的 payload） */
  function compose(configText, listeners, groups, runtimeTun) {
    var doc = yamledit.splitTopLevel(configText);
    stripOurLines(doc);
    upsertGroups(doc, groups);
    upsertListeners(doc, listeners);
    var text = yamledit.joinTopLevel(doc);
    return flattenTun(text, runtimeTun);
  }

  /* 只更新 listeners（用在后端写入 Verge 的 merge 模板） */
  function composeListenersOnly(configText, listeners) {
    var doc = yamledit.splitTopLevel(configText);
    stripOurLines(doc);
    upsertListeners(doc, listeners);
    return yamledit.joinTopLevel(doc);
  }

  /* 把组写进 groups 模板的 append 块（SeqMap: prepend/append/delete） */
  function composeGroupsTemplate(templateText, groups) {
    var doc = yamledit.splitTopLevel(templateText);
    var block = yamledit.findBlock(doc, 'append');
    if (!block) {
      block = { key: 'append', lines: ['append:'] };
      doc.blocks.push(block);
    }
    // 先清掉上一轮我们留下的标记与条目（兼容被 Verge 界面改写后丢标记的情况）
    block.lines = removeOurEntries(yamledit.stripMarked(block.lines, TAG));
    if (groups && groups.length) {
      if (!normalizeKeyLine(block)) {
        throw new Error('groups 模板的 append 不是块状列表，PortPilot 无法安全写入');
      }
      yamledit.insertIntoSeqBlock(block, model.renderGroupItems(groups), TAG);
    }
    ensureSeqKeys(doc);
    return yamledit.joinTopLevel(doc);
  }

  /* 从块内容里删掉 name 以 PortPilot- 开头的序列项 */
  function removeOurEntries(lines) {
    var out = [];
    var skipping = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (i === 0) { out.push(line); continue; }
      var m = /^(\s*)-\s*(.*)$/.exec(line);
      if (m) {
        var body = m[2];
        var nameMatch = /^name:\s*(.*)$/.exec(body.trim());
        if (nameMatch) {
          var raw = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
          skipping = model.isOurName(raw);
        } else {
          skipping = false;
        }
        if (skipping) continue;
        out.push(line);
        continue;
      }
      if (skipping) {
        if (!line.trim()) continue;
        if (/^\s/.test(line)) continue;
      }
      out.push(line);
    }
    return out;
  }

  /* SeqMap 需要 prepend / append / delete 三个键同时存在，否则 Verge 解析会失败 */
  function ensureSeqKeys(doc) {
    ['prepend', 'append', 'delete'].forEach(function (key) {
      if (!yamledit.findBlock(doc, key)) {
        doc.blocks.push({ key: key, lines: [key + ': []'] });
      }
    });
  }

  function hasOurMarkers(text) {
    return String(text || '').indexOf('# >>> ' + TAG) >= 0;
  }

  return {
    TAG: TAG,
    compose: compose,
    composeListenersOnly: composeListenersOnly,
    composeGroupsTemplate: composeGroupsTemplate,
    flattenTun: flattenTun,
    renderTunLines: renderTunLines,
    removeOurEntries: removeOurEntries,
    ensureSeqKeys: ensureSeqKeys,
    hasOurMarkers: hasOurMarkers
  };
});
