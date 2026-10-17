/* 设置 */
(function () {
  'use strict';
  var PP = window.PP;
  var esc = PP.util.escapeHtml;

  PP.pages = PP.pages || {};

  PP.pages.settings = {
    title: '设置',
    subtitle: '外观、测速地址、导入导出与还原',

    render: function (ctx) {
      var v = ctx.view;
      var st = ctx.core.state.settings;

      var head = '<div class="page-head"><div><h1>设置</h1><p>' + esc(this.subtitle) + '</p></div></div>';

      var appearance =
        '<div class="card"><h3>外观</h3><div class="split">' +
        '<div class="field"><span>主题</span><select data-act="theme">' +
        '<option value="system"' + (st.theme === 'system' ? ' selected' : '') + '>跟随系统</option>' +
        '<option value="light"' + (st.theme === 'light' ? ' selected' : '') + '>浅色</option>' +
        '<option value="dark"' + (st.theme === 'dark' ? ' selected' : '') + '>深色</option>' +
        '</select><span class="inline-note">跟随系统时会随 Windows 的深浅色设置实时切换。</span></div>' +
        '<div class="field"><span>测速地址</span><input type="text" data-act="testurl" value="' +
        esc(st.testUrl) + '"><span class="inline-note">测速通过这个地址测延迟。</span></div>' +
        '</div></div>';

      var data =
        '<div class="card"><h3>配置</h3><div class="row">' +
        '<button class="button" data-act="export">导出配置</button>' +
        '<button class="button" data-act="import">导入配置</button>' +
        '<button class="button" data-act="open-data">打开数据目录</button>' +
        '</div><p class="inline-note" style="margin-top:10px">' +
        '导出的文件只包含端口号、开关与所选节点，不含任何订阅信息。</p></div>';

      var danger =
        '<div class="card"><h3>还原</h3>' +
        '<p class="hint-line">把 PortPilot 写进 Clash Verge 的内容全部撤掉：端口停止监听，扩展模板还原成原来的样子。' +
        '你原来的订阅、规则、节点都不受影响。</p>' +
        '<div class="row" style="margin-top:12px">' +
        '<button class="button danger" data-act="reset">移除全部端口并还原</button>' +
        '<button class="button" data-act="clear-log">清空运行记录</button>' +
        '</div></div>';

      var about =
        '<div class="card"><h3>关于</h3><dl class="kv">' +
        '<dt>版本</dt><dd>PortPilot ' + esc(v.app ? v.app.version : '—') + '</dd>' +
        '<dt>Clash Verge</dt><dd>' + (v.core.ok ? '已就绪，内核 ' + esc(v.core.version || '—') : '未就绪（' + esc(v.core.error || '未运行') + '）') + '</dd>' +
        '<dt>内核端口</dt><dd>' + (v.core.mixedPort ? ('混合端口 ' + v.core.mixedPort) : '—') + '</dd>' +
        '<dt>控制通道</dt><dd class="mono">' + esc(v.core.pipe || '—') + '</dd>' +
        '<dt>数据目录</dt><dd class="mono">' + esc(v.paths ? v.paths.appDataDir : '—') + '</dd>' +
        '<dt>当前订阅</dt><dd class="mono">' + esc(v.paths ? v.paths.profilesYamlPath : '—') + '</dd>' +
        '</dl></div>';

      return {
        html: head + appearance + data + danger + about,
        handlers: {
          'theme': function (data2, e) {
            ctx.core.state.settings.theme = e.target.value;
            ctx.core.save();
            ctx.applyTheme();
            ctx.rerender();
          },
          'testurl': function (data2, e) {
            var value = String(e.target.value || '').trim();
            if (!value) return;
            ctx.core.state.settings.testUrl = value;
            ctx.core.save().then(function () { PP.ui.toast('ok', '测速地址已保存'); });
          },
          'export': function () {
            var text = ctx.core.exportConfig();
            ctx.bridge.invoke('dialog.saveText', {
              defaultName: 'portpilot-config.json',
              content: text
            }).then(function (res) {
              if (res && !res.canceled) PP.ui.toast('ok', '已导出到 ' + res.path);
            }, function (err) { PP.ui.toast('err', err.message); });
          },
          'import': function () {
            ctx.bridge.invoke('dialog.openText').then(function (res) {
              if (!res) return;
              var parsed = PP.util.safeJson(res.text, null);
              if (!parsed) { PP.ui.toast('err', '这不是一份合法的 PortPilot 配置'); return; }
              PP.ui.confirmModal({
                title: '导入配置？',
                body: '会用文件里的端口与节点覆盖当前设置，然后立刻重新打开端口。',
                okText: '导入'
              }).then(function (ok) {
                if (!ok) return;
                ctx.run(function () { return ctx.core.importConfig(res.text); }, '配置已导入');
              });
            }, function (err) { PP.ui.toast('err', err.message); });
          },
          'open-data': function () {
            ctx.bridge.invoke('shell.open', { path: v.paths.appDataDir });
          },
          'reset': function () {
            PP.ui.confirmModal({
              title: '移除全部端口并还原？',
              html: '所有端口都会停止监听，PortPilot 写进 Clash Verge 的内容会被撤掉。<br>你的订阅与节点不受影响。',
              okText: '还原', danger: true
            }).then(function (ok) {
              if (!ok) return;
              ctx.run(function () { return ctx.core.reset(); }, '已经还原');
            });
          },
          'clear-log': function () {
            ctx.run(function () {
              return ctx.core.runLog.clear().then(function () { PP.ui.toast('ok', '运行记录已清空'); });
            }, null);
          }
        }
      };
    }
  };
})();
