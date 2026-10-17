/* 规则与策略组：只读预览 */
(function () {
  'use strict';
  var PP = window.PP;
  var esc = PP.util.escapeHtml;

  PP.pages = PP.pages || {};

  var GROUP_TYPES = ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'];

  PP.pages.rules = {
    title: '规则',
    subtitle: 'Clash Verge 当前的规则与策略组（只读）',

    /* 进入页面时读一次（只读，不改任何东西） */
    enter: function (ctx) {
      if (!ctx.core.core_.ok) return;
      ctx.run(function () {
        return ctx.core.loadRules().then(function () { return ctx.refresh(); });
      }, null);
    },

    render: function (ctx) {
      var v = ctx.view;
      var rules = v.rules || [];
      var groups = [];
      Object.keys(ctx.core.proxies).forEach(function (name) {
        var proxy = ctx.core.proxies[name];
        if (!proxy) return;
        if (GROUP_TYPES.indexOf(String(proxy.type)) < 0) return;
        if (PP.model.isOurName(name)) return;
        groups.push({
          name: proxy.name || name,
          type: proxy.type,
          now: proxy.now || null,
          count: (proxy.all || []).length
        });
      });

      var head =
        '<div class="page-head"><div><h1>规则</h1><p>' + esc(this.subtitle) + '</p></div>' +
        '<div class="head-actions"><button class="button primary" data-act="refresh">读取</button></div></div>';

      if (!v.core.ok) head += '<div class="err-box">Clash Verge 未运行，读不到规则。</div>';

      var rulesTable = rules.length
        ? '<div class="table-wrap" style="max-height:46vh"><table><thead><tr>' +
        '<th style="width:170px">类型</th><th>内容</th><th style="width:280px">命中后走</th></tr></thead><tbody>' +
        rules.map(function (r) {
          return '<tr><td class="mono">' + esc(r.type) + '</td>' +
            '<td class="mono">' + esc(r.payload || '') + '</td>' +
            '<td>' + esc(r.proxy || '') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<p class="hint-line">还没有读取到规则，点右上角「读取」。</p>';

      var groupsTable = groups.length
        ? '<div class="table-wrap" style="max-height:36vh"><table><thead><tr>' +
        '<th>名称</th><th style="width:130px">类型</th><th style="width:280px">当前节点</th><th class="num">成员</th>' +
        '</tr></thead><tbody>' +
        groups.map(function (g) {
          return '<tr><td>' + esc(g.name) + '</td><td class="mono">' + esc(g.type) + '</td>' +
            '<td>' + esc(g.now || '—') + '</td><td class="num">' + g.count + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<p class="hint-line">还没有读取到策略组。</p>';

      return {
        html: head +
          '<div class="card"><h3>规则<span class="hint">共 ' + rules.length + ' 条</span></h3>' + rulesTable + '</div>' +
          '<div class="card"><h3>策略组<span class="hint">共 ' + groups.length + ' 个</span></h3>' + groupsTable + '</div>',
        handlers: {
          'refresh': function () {
            ctx.run(function () {
              return ctx.core.loadRules().then(function () { return ctx.refresh(); });
            }, '已读取规则与策略组');
          }
        }
      };
    }
  };
})();
