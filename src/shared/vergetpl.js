/* 后端写入：跑在 Clash Verge 的订阅扩展模板上（先备份、再原子写、失败可还原） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./util.js'), require('./yamledit.js'), require('./payload.js'), require('./model.js'));
  } else {
    root.PP = root.PP || {};
    root.PP.vergetpl = factory(root.PP.util, root.PP.yamledit, root.PP.payload, root.PP.model);
  }
})(typeof self !== 'undefined' ? self : this, function (util, yamledit, payload, model) {
  'use strict';

  var MERGE_TEMPLATE = '# Profile Enhancement Merge Template for Clash Verge\n';
  var GROUPS_TEMPLATE = '# Profile Enhancement Groups Template for Clash Verge\n\nprepend: []\n\nappend: []\n\ndelete: []\n';

  function scalar(text) {
    if (text === null || text === undefined) return null;
    var v = String(text).trim().replace(/^['"]|['"]$/g, '');
    if (v === '' || v === 'null' || v === '~') return null;
    return v;
  }

  function parseProfiles(text) {
    var lines = yamledit.parseLines(text);
    var current = null;
    var items = [];
    var currentItem = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var cur = /^current:\s*(.*)$/.exec(line);
      if (cur) current = scalar(cur[1]);
      var m = /^(\s*)-\s*uid:\s*(\S+)\s*$/.exec(line);
      if (m) {
        currentItem = { uid: m[2], indent: m[1], start: i, end: lines.length, lines: [], type: null, file: null, merge: null, groups: null };
        items.push(currentItem);
        continue;
      }
      if (currentItem) currentItem.end = i + 1;
    }
    items.forEach(function (item) {
      item.lines = lines.slice(item.start, item.end);
      item.lines.forEach(function (l) {
        var t = /^\s*type:\s*(.*)$/.exec(l);
        if (t && item.type === null) item.type = scalar(t[1]);
        var f = /^\s*file:\s*(.*)$/.exec(l);
        if (f && item.file === null) item.file = scalar(f[1]);
      });
      var optIndex = -1;
      var optIndent = 0;
      for (var k = 0; k < item.lines.length; k++) {
        var o = /^(\s*)option:\s*$/.exec(item.lines[k]);
        if (o) { optIndex = k; optIndent = o[1].length; break; }
      }
      if (optIndex >= 0) {
        for (var j = optIndex + 1; j < item.lines.length; j++) {
          var l2 = item.lines[j];
          if (!l2.trim()) continue;
          var ind = yamledit.indentOf(l2).length;
          if (ind <= optIndent) break;
          var mm = /^\s*merge:\s*(.*)$/.exec(l2);
          if (mm) item.merge = scalar(mm[1]);
          var gg = /^\s*groups:\s*(.*)$/.exec(l2);
          if (gg) item.groups = scalar(gg[1]);
        }
      }
    });
    return { current: current, items: items, lines: lines };
  }

  function setItemOption(text, uid, key, value) {
    var lines = yamledit.parseLines(text);
    var start = -1;
    var itemIndent = '';
    for (var i = 0; i < lines.length; i++) {
      var m = /^(\s*)-\s*uid:\s*(\S+)\s*$/.exec(lines[i]);
      if (m && m[2] === uid) { start = i; itemIndent = m[1]; break; }
    }
    if (start < 0) throw new Error('profiles.yaml 里找不到订阅 ' + uid);

    var end = lines.length;
    var itemRe = new RegExp('^' + itemIndent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\s');
    for (var j = start + 1; j < lines.length; j++) {
      if (itemRe.test(lines[j])) { end = j; break; }
    }

    var optIndex = -1;
    var optIndent = 0;
    for (var k = start + 1; k < end; k++) {
      var o = /^(\s*)option:\s*$/.exec(lines[k]);
      if (o) { optIndex = k; optIndent = o[1].length; break; }
    }

    if (optIndex >= 0) {
      var optEnd = end;
      for (var q = optIndex + 1; q < end; q++) {
        if (!lines[q].trim()) continue;
        if (yamledit.indentOf(lines[q]).length <= optIndent) { optEnd = q; break; }
      }
      for (var r = optIndex + 1; r < optEnd; r++) {
        var exist = new RegExp('^\\s*' + key + ':').exec(lines[r]);
        if (exist) {
          lines[r] = yamledit.indentOf(lines[r]) + key + ': ' + value;
          return lines.join('\n');
        }
      }
      lines.splice(optIndex + 1, 0, new Array(optIndent + 3).join(' ') + key + ': ' + value);
      return lines.join('\n');
    }

    var insertAt = end;
    while (insertAt > start && !lines[insertAt - 1].trim()) insertAt--;
    lines.splice(insertAt, 0, itemIndent + '  option:', itemIndent + '    ' + key + ': ' + value);
    return lines.join('\n');
  }

  function appendItem(text, uid, type, file) {
    var lines = yamledit.parseLines(text);
    var lastKey = null;
    for (var i = 0; i < lines.length; i++) {
      if (yamledit.isKeyLine(lines[i])) lastKey = /^([^:]+):/.exec(lines[i])[1];
    }
    if (lastKey !== 'items') {
      throw new Error('profiles.yaml 的结构不符合预期（items 不是最后一个配置块）。请在 Clash Verge 里打开一次「扩展配置」再试。');
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push('- uid: ' + uid);
    lines.push('  type: ' + type);
    lines.push('  name: null');
    lines.push('  file: ' + file);
    lines.push('  updated: null');
    return lines.join('\n') + '\n';
  }

  /* 运行时的模板路径解析结果 */
  function resolveTemplatePaths(text) {
    var parsed = parseProfiles(text);
    if (!parsed.current) throw new Error('profiles.yaml 里没有 current，请在 Clash Verge 里选择一个订阅');
    var currentItem = null;
    parsed.items.forEach(function (it) { if (it.uid === parsed.current) currentItem = it; });
    if (!currentItem) throw new Error('profiles.yaml 里的 current（' + parsed.current + '）找不到对应订阅');
    return { parsed: parsed, current: currentItem };
  }

  function fileForUid(parsed, uid, fallback) {
    var found = null;
    parsed.items.forEach(function (it) { if (it.uid === uid) found = it; });
    if (found && found.file) return found.file;
    return fallback;
  }

  /* 主入口：把 listeners 与每端口的组写进当前订阅的扩展模板
     opts: { io, profilesYaml, profilesDir, backupDir, stamp, listeners, groups } */
  function apply(opts) {
    var io = opts.io;
    var listeners = opts.listeners || [];
    var groups = opts.groups || [];
    var result = { files: [], backups: {}, createdItems: [], profilesChanged: false };

    return io.readText(opts.profilesYaml).then(function (profilesText) {
      var resolved = resolveTemplatePaths(profilesText);
      var parsed = resolved.parsed;
      var current = resolved.current;
      var working = profilesText;

      var mergeUid = current.merge;
      var groupsUid = current.groups;
      var createMerge = false;
      var createGroups = false;

      if (!mergeUid) { mergeUid = 'ppmerge'; createMerge = true; }
      if (!groupsUid) { groupsUid = 'ppgroups'; createGroups = true; }

      var mergeFile = fileForUid(parsed, mergeUid, mergeUid + '.yaml');
      var groupsFile = fileForUid(parsed, groupsUid, groupsUid + '.yaml');

      if (createMerge) {
        if (!fileForUid(parsed, mergeUid, null)) {
          working = appendItem(working, mergeUid, 'merge', mergeFile);
          result.createdItems.push(mergeUid);
        }
        working = setItemOption(working, current.uid, 'merge', mergeUid);
        result.profilesChanged = true;
      }
      if (createGroups) {
        if (!fileForUid(parsed, groupsUid, null)) {
          working = appendItem(working, groupsUid, 'groups', groupsFile);
          result.createdItems.push(groupsUid);
        }
        working = setItemOption(working, current.uid, 'groups', groupsUid);
        result.profilesChanged = true;
      }

      var mergePath = joinPath(opts.profilesDir, mergeFile);
      var groupsPath = joinPath(opts.profilesDir, groupsFile);
      result.mergePath = mergePath;
      result.groupsPath = groupsPath;
      result.mergeFile = mergeFile;
      result.groupsFile = groupsFile;

      var backupDir = joinPath(opts.backupDir, opts.stamp);

      // 1. 备份并写 profiles.yaml（仅在需要时）
      var chain = Promise.resolve();
      if (result.profilesChanged) {
        chain = chain.then(function () {
          return io.exists(opts.profilesYaml).then(function (yes) {
            if (!yes) return null;
            return io.copyFile(opts.profilesYaml, joinPath(backupDir, 'profiles.yaml')).then(function () {
              result.backups[opts.profilesYaml] = joinPath(backupDir, 'profiles.yaml');
            });
          });
        }).then(function () {
          return io.writeTextAtomic(opts.profilesYaml, working);
        });
      }

      // 2. 写 merge 模板（listeners）
      chain = chain.then(function () {
        return readOrDefault(io, mergePath, MERGE_TEMPLATE).then(function (existing) {
          var next = payload.composeListenersOnly(existing, listeners);
          var backupPath = joinPath(backupDir, mergeFile);
          result.backups[mergePath] = backupPath;
          return backupAndWrite(io, mergePath, next, backupPath, existing);
        });
      });

      // 3. 写 groups 模板（每端口的组）
      chain = chain.then(function () {
        return readOrDefault(io, groupsPath, GROUPS_TEMPLATE).then(function (existing) {
          var next = payload.composeGroupsTemplate(existing, groups);
          var backupPath = joinPath(backupDir, groupsFile);
          result.backups[groupsPath] = backupPath;
          return backupAndWrite(io, groupsPath, next, backupPath, existing);
        });
      });

      // 4. 回读校验
      chain = chain.then(function () {
        return io.readText(mergePath).then(function (t) {
          if (listeners.length && t.indexOf('listeners:') < 0) {
            throw new Error('写入后回读校验失败（merge 模板里没有 listeners）');
          }
          return io.readText(groupsPath).then(function (g) {
            if (groups.length && g.indexOf('append:') < 0) {
              throw new Error('写入后回读校验失败（groups 模板里没有 append）');
            }
            return result;
          });
        });
      });

      return chain;
    });
  }

  /* 还原：把备份写回目标 */
  function restore(io, backups) {
    var keys = Object.keys(backups || {});
    var chain = Promise.resolve();
    keys.forEach(function (target) {
      chain = chain.then(function () {
        return io.copyFile(backups[target], target);
      });
    });
    return chain.then(function () { return keys.length; });
  }

  /* 把监听器清空（还原成没有任何 PortPilot 端口） */
  function clear(io, opts) {
    return apply({
      io: io,
      profilesYaml: opts.profilesYaml,
      profilesDir: opts.profilesDir,
      backupDir: opts.backupDir,
      stamp: opts.stamp,
      listeners: [],
      groups: []
    });
  }

  function readOrDefault(io, path, fallback) {
    return io.exists(path).then(function (yes) {
      if (!yes) return fallback;
      return io.readText(path);
    });
  }

  /* 先落备份（目标不存在时把即将使用的原文写进备份），再原子写目标 */
  function backupAndWrite(io, target, next, backupPath, originalWhenMissing) {
    return io.exists(target).then(function (yes) {
      var prep = yes
        ? io.copyFile(target, backupPath)
        : io.writeTextAtomic(backupPath, originalWhenMissing);
      return prep.then(function () {
        return io.writeTextAtomic(target, next);
      });
    });
  }

  function joinPath(dir, name) {
    if (!dir) return name;
    var sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
    if (dir.charAt(dir.length - 1) === '\\' || dir.charAt(dir.length - 1) === '/') return dir + name;
    return dir + sep + name;
  }

  return {
    MERGE_TEMPLATE: MERGE_TEMPLATE,
    GROUPS_TEMPLATE: GROUPS_TEMPLATE,
    parseProfiles: parseProfiles,
    setItemOption: setItemOption,
    appendItem: appendItem,
    resolveTemplatePaths: resolveTemplatePaths,
    apply: apply,
    restore: restore,
    clear: clear,
    joinPath: joinPath
  };
});
