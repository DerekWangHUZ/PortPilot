/* 极简 YAML 顶层块编辑器：只处理“顶层键 + 其块内容”，够 PortPilot 用，且完全可测。
   约定：
   - 顶层键行 = 列 0 且形如 key: 的行（不以 - 开头）
   - 以 - 开头（列 0）或带缩进的行，都属于它上方的那个键
   - 注释行按位置归入当前块（或文首前言）
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.PP = root.PP || {}; root.PP.yamledit = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.\-]*):(.*)$/;

  function isKeyLine(line) {
    if (!line || /^\s/.test(line) || line.charAt(0) === '-') return false;
    var m = KEY_RE.exec(line);
    return !!m;
  }

  function splitTopLevel(text) {
    var lines = String(text === null || text === undefined ? '' : text).split(/\r?\n/);
    var preamble = [];
    var blocks = [];
    var current = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (isKeyLine(line)) {
        if (current) blocks.push(current);
        current = { key: KEY_RE.exec(line)[1], lines: [line] };
      } else if (current) {
        current.lines.push(line);
      } else {
        preamble.push(line);
      }
    }
    if (current) blocks.push(current);
    return { preamble: preamble, blocks: blocks };
  }

  function joinTopLevel(doc) {
    var out = [];
    (doc.preamble || []).forEach(function (l) { out.push(l); });
    (doc.blocks || []).forEach(function (b) {
      b.lines.forEach(function (l) { out.push(l); });
    });
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n') + '\n';
  }

  function findBlock(doc, key) {
    for (var i = 0; i < doc.blocks.length; i++) {
      if (doc.blocks[i].key === key) return doc.blocks[i];
    }
    return null;
  }

  function removeBlock(doc, key) {
    var removed = [];
    doc.blocks = doc.blocks.filter(function (b) {
      if (b.key === key) { removed.push(b); return false; }
      return true;
    });
    return removed;
  }

  /* 取出块内第一个序列项的缩进（- 之前的部分）；没有序列项时返回 null */
  function seqItemIndent(block) {
    if (!block) return null;
    for (var i = 1; i < block.lines.length; i++) {
      var line = block.lines[i];
      if (!line.trim()) continue;
      var m = /^(\s*)-\s/.exec(line);
      if (m) return m[1];
      // 遇到非空且非注释、又不是序列项的内容，说明结构不是块序列
      if (line.trim().charAt(0) !== '#') return null;
    }
    return null;
  }

  /* 去掉被标记包裹的行（含标记行本身） */
  function stripMarked(lines, tag) {
    var open = '# >>> ' + tag;
    var close = '# <<< ' + tag;
    var out = [];
    var inside = false;
    (lines || []).forEach(function (line) {
      var t = String(line).trim();
      if (t.indexOf(open) === 0) { inside = true; return; }
      if (t.indexOf(close) === 0) { inside = false; return; }
      if (!inside) out.push(line);
    });
    return out;
  }

  function hasMarker(lines, tag) {
    var open = '# >>> ' + tag;
    return (lines || []).some(function (l) { return String(l).trim().indexOf(open) === 0; });
  }

  function marked(tag, lines, indent) {
    var pad = indent || '';
    return [pad + '# >>> ' + tag].concat(lines).concat([pad + '# <<< ' + tag]);
  }

  /* 在序列块的关键字行之后插入一组带标记的行 */
  function insertIntoSeqBlock(block, lines, tag) {
    var indent = seqItemIndent(block);
    if (indent === null) indent = '';
    var padded = lines.map(function (l) { return l ? indent + l : l; });
    var body = marked(tag, padded, indent);
    block.lines = [block.lines[0]].concat(body, block.lines.slice(1));
    return block;
  }

  function blockIsEmptyFlow(block) {
    if (!block || block.lines.length < 2) return true;
    var rest = block.lines.slice(1).filter(function (l) { return l.trim() !== ''; });
    if (rest.length === 0) return true;
    if (rest.length === 1 && /^\s*\[\s*\]\s*$/.test(rest[0])) return true;
    return false;
  }

  /* 把一个键的值行（不含键行）替换为给定的块内容 */
  function setBlockBody(block, bodyLines) {
    block.lines = [block.lines[0]].concat(bodyLines || []);
    return block;
  }

  function indentOf(line) {
    var m = /^(\s*)/.exec(line || '');
    return m ? m[1] : '';
  }

  function parseLines(text) { return String(text === null || text === undefined ? '' : text).split(/\r?\n/); }

  return {
    splitTopLevel: splitTopLevel,
    joinTopLevel: joinTopLevel,
    findBlock: findBlock,
    removeBlock: removeBlock,
    seqItemIndent: seqItemIndent,
    stripMarked: stripMarked,
    hasMarker: hasMarker,
    marked: marked,
    insertIntoSeqBlock: insertIntoSeqBlock,
    blockIsEmptyFlow: blockIsEmptyFlow,
    setBlockBody: setBlockBody,
    indentOf: indentOf,
    parseLines: parseLines,
    isKeyLine: isKeyLine
  };
});
