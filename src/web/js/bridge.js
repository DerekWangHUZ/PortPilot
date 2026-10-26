/* 与宿主（Go / Wails）通信。
   PPBridge.invoke(method, params) 返回 Promise；
   PPBridge.on(name, fn) 订阅宿主推来的事件（theme / config.changed）。 */
(function () {
  'use strict';

  function appBinding() {
    return (window.go && window.go.main && window.go.main.App) || null;
  }

  var bridge = {
    available: !!appBinding(),
    invoke: function (method, params) {
      var app = appBinding();
      if (!app || typeof app.Call !== 'function') {
        return Promise.reject(new Error('当前不在 PortPilot 窗口里运行'));
      }
      var payload;
      try {
        payload = JSON.stringify(params || {});
      } catch (e) {
        return Promise.reject(e);
      }
      return Promise.resolve(app.Call(method, payload)).then(function (text) {
        if (!text) return {};
        return JSON.parse(text);
      });
    },
    on: function (name, fn) {
      if (!window.runtime || typeof window.runtime.EventsOn !== 'function') return;
      window.runtime.EventsOn(name, function (data) {
        try { fn(data); } catch (e) { }
      });
    }
  };

  window.PPBridge = bridge;
  window.PP = window.PP || {};
  window.PP.bridge = bridge;
})();
