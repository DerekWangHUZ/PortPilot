/* 连接与流量：快照式，不自动轮询 */
(function () {
  'use strict';
  var PP = window.PP;
  var esc = PP.util.escapeHtml;
  var fmt = PP.util.formatBytes;

  PP.pages = PP.pages || {};

  function aggregate(core, view) {
    var data = view.connections || { connections: [], downloadTotal: 0, uploadTotal: 0 };
    var byPort = {};
    view.ports.forEach(function (p) {
      byPort[p.port] = { port: p.port, count: 0, up: 0, down: 0, items: [] };
    });
    var other = { port: null, count: 0, up: 0, down: 0, items: [] };

    (data.connections || []).forEach(function (conn) {
      var meta = conn.metadata || {};
      var name = meta.inboundName || '';
      var m = /^PortPilot-(\d+)$/.exec(name);
      var bucket = (m && byPort[parseInt(m[1], 10)]) ? byPort[parseInt(m[1], 10)] : other;
      bucket.count++;
      bucket.up += conn.upload || 0;
      bucket.down += conn.download || 0;
      bucket.items.push({
        host: meta.host || meta.destinationIP || '',
        network: meta.network || '',
        rule: conn.rule ? (conn.rule + (conn.rulePayload ? '(' + conn.rulePayload + ')' : '')) : '',
        chains: (conn.chains || []).join(' → '),
        up: conn.upload || 0,
        down: conn.download || 0,
        start: conn.start
      });
    });

    return { byPort: byPort, other: other, total: data };
  }

  PP.pages.connections = {
    title: '连接与流量',
    subtitle: '按端口汇总当前连接与流量（快照）',

    /* 进入页面时抓一次快照（不做定时轮询） */
    enter: function (ctx) {
      if (!ctx.core.core_.ok) return;
      ctx.run(function () { return ctx.refresh({ withConnections: true }); }, null);
    },

    render: function (ctx) {
      var v = ctx.view;
      var agg = aggregate(ctx.core, v);      var totalUp = agg.total.uploadTotal || 0;
      var totalDown = agg.total.downloadTotal || 0;
      var busyCount = 0;
      Object.keys(agg.byPort).forEach(function (k) { busyCount += agg.byPort[k].count; });

      var head =
        '<div class="page-head"><div><h1>连接与流量</h1><p>' + esc(this.subtitle) + '</p></div>' +
        '<div class="head-actions"><button class="button primary" data-act="refresh">刷新快照</button></div></div>';

      if (!v.core.ok) head += '<div class="err-box">Clash Verge 未运行，读不到连接信息。</div>';

      var cards =
        '<div class="grid cols-4" style="margin-bottom:14px">' +
        '<div class="stat"><span>端口连接数</span><b>' + busyCount + '</b><small>不含系统自身流量</small></div>' +
        '<div class="stat"><span>其他连接</span><b>' + agg.other.count + '</b><small>TUN / 系统代理</small></div>' +
        '<div class="stat"><span>累计上传</span><b>' + fmt(totalUp) + '</b><small>内核启动以来</small></div>' +
        '<div class="stat"><span>累计下载</span><b>' + fmt(totalDown) + '</b><small>内核启动以来</small></div>' +
        '</div>';

      var rows = v.ports.map(function (p) {
        var b = agg.byPort[p.port] || { count: 0, up: 0, down: 0 };
        return '<tr>' +
          '<td class="mono">127.0.0.1:' + p.port + '</td>' +
          '<td>' + PP.ui.statusBadge(p) + '</td>' +
          '<td title="' + esc(p.node || '') + '">' + (p.node ? esc(p.node) : '<span class="inline-note">未选择</span>') + '</td>' +
          '<td class="num">' + b.count + '</td>' +
          '<td class="num">' + fmt(b.up) + '</td>' +
          '<td class="num">' + fmt(b.down) + '</td>' +
          '<td class="num"><button class="button small" data-act="detail" data-port="' + p.port + '">明细</button></td>' +
          '</tr>';
      }).join('');

      var table = v.ports.length
        ? '<div class="card"><h3>按端口汇总</h3><div class="table-wrap"><table class="fixed"><colgroup>' +
        '<col style="width:19%"><col style="width:13%"><col style="width:26%"><col style="width:8%">' +
        '<col style="width:11%"><col style="width:11%"><col style="width:12%"></colgroup><thead><tr>' +
        '<th>端口</th><th>状态</th><th>节点</th><th class="num">连接</th><th class="num">上传</th>' +
        '<th class="num">下载</th><th></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div></div>'
        : '<div class="card"><div class="empty"><div class="visual"><svg viewBox="0 0 24 24"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg></div><h2>还没有端口</h2><p>新建端口之后，这里会按端口汇总活动连接与流量。</p></div></div>';

      var detail = '';
      if (ctx.options && ctx.options.detailPort !== undefined && ctx.options.detailPort !== null) {
        var port = ctx.options.detailPort;
        var bucket = agg.byPort[port];
        var items = bucket ? bucket.items : [];
        detail = '<div class="card"><h3>端口 ' + port + ' 的连接明细</h3>' +
          (items.length
            ? '<div class="table-wrap"><table><thead><tr><th>目标</th><th>协议</th><th>匹配规则</th><th>链路</th>' +
            '<th class="num">上传</th><th class="num">下载</th></tr></thead><tbody>' +
            items.map(function (i) {
              return '<tr><td>' + esc(i.host || '—') + '</td><td>' + esc(i.network) + '</td>' +
                '<td class="mono">' + esc(i.rule || '—') + '</td>' +
                '<td>' + esc(i.chains || '—') + '</td>' +
                '<td class="num">' + fmt(i.up) + '</td><td class="num">' + fmt(i.down) + '</td></tr>';
            }).join('') + '</tbody></table></div>'
            : '<p class="hint-line">这个端口当前没有活动连接。</p>') +
          '</div>';
      }

      return {
        html: head + cards + table + detail,
        handlers: {
          'refresh': function () {
            ctx.run(function () { return ctx.refresh({ withConnections: true }); }, '快照已刷新');
          },
          'detail': function (data) {
            ctx.setOptions({ detailPort: parseInt(data.port, 10) });
            ctx.rerender();
          }
        }
      };
    }
  };
})();
