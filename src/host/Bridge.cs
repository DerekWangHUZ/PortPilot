using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace PortPilot
{
    /// <summary>JS 与宿主之间的消息桥。所有耗时操作在后台线程执行，结果回投到界面线程。</summary>
    internal sealed class Bridge
    {
        private readonly Control _ui;
        private readonly CoreWebView2 _core;
        private static int _pending;
        private volatile bool _detached;

        internal Bridge(Control ui, CoreWebView2 core)
        {
            _ui = ui;
            _core = core;
        }

        internal static int Pending { get { return _pending; } }

        internal void Detach() { _detached = true; }

        internal void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (_detached) return;
            string raw;
            try { raw = e.WebMessageAsJson; }
            catch { return; }

            Dictionary<string, object> msg;
            try { msg = Json.AsMap(Json.Parse(raw)); }
            catch { return; }
            if (msg == null) return;

            object id = msg.ContainsKey("id") ? msg["id"] : null;
            var method = Json.GetString(msg, "method", "");
            var pars = Json.Get(msg, "params");
            if (string.IsNullOrEmpty(method)) return;

            Interlocked.Increment(ref _pending);
            ThreadPool.QueueUserWorkItem(delegate (object state)
            {
                object data = null;
                string error = null;
                try
                {
                    data = Dispatch(method, pars);
                }
                catch (Exception ex)
                {
                    error = ex.Message;
                    ErrorLog.Write("处理 " + method + " 失败", ex);
                }
                finally
                {
                    Interlocked.Decrement(ref _pending);
                }
                Reply(id, data, error);
            });
        }

        private void Reply(object id, object data, string error)
        {
            if (_detached) return;
            var payload = Json.Map("id", id, "ok", error == null, "data", data, "error", error);
            Post(payload);
        }

        internal void PushEvent(string name, object data)
        {
            Post(Json.Map("event", name, "data", data));
        }

        private void Post(object payload)
        {
            if (_detached) return;
            var text = Json.Stringify(payload);
            try
            {
                if (_ui.IsHandleCreated)
                {
                    _ui.BeginInvoke((Action)delegate ()
                    {
                        try { _core.PostWebMessageAsJson(text); }
                        catch { }
                    });
                }
            }
            catch { }
        }

        private T OnUi<T>(Func<T> func)
        {
            return (T)_ui.Invoke(func);
        }

        private object Dispatch(string method, object pars)
        {
            switch (method)
            {
                case "window.minimize":
                    {
                        var f = _ui as MainForm;
                        if (f != null) OnUi(delegate () { f.WindowMinimize(); return 0; });
                        return Json.Map("ok", true);
                    }
                case "window.toggleMaximize":
                    {
                        var f = _ui as MainForm;
                        var max = false;
                        if (f != null) max = OnUi(delegate () { f.WindowToggleMaximize(); return f.IsMaximized; });
                        return Json.Map("ok", true, "maximized", max);
                    }
                case "window.beginResize":
                    {
                        var f = _ui as MainForm;
                        var edge = Json.GetString(pars, "edge", "left");
                        int ht = 1;
                        if (edge == "left") ht = 10;
                        else if (edge == "right") ht = 11;
                        else if (edge == "top") ht = 12;
                        else if (edge == "topleft") ht = 13;
                        else if (edge == "topright") ht = 14;
                        else if (edge == "bottom") ht = 15;
                        else if (edge == "bottomleft") ht = 16;
                        else if (edge == "bottomright") ht = 17;
                        if (f != null) OnUi(delegate () { f.WindowBeginResize(ht); return 0; });
                        return Json.Map("ok", true);
                    }                case "window.beginDrag":
                    {
                        var f = _ui as MainForm;
                        if (f != null) OnUi(delegate () { f.WindowBeginDrag(); return 0; });
                        return Json.Map("ok", true);
                    }
                case "window.setFrame":
                    {
                        var f = _ui as MainForm;
                        var color = Json.GetString(pars, "color", "");
                        if (f != null) OnUi(delegate () { f.SetFrameColor(color); return 0; });
                        return Json.Map("ok", true);
                    }                case "app.info": return AppInfo();
                case "app.exit": return ExitApp();
                case "app.ping": return Json.Map("pong", true);

                case "pipe.discover": return PipeInfo(true);
                case "pipe.status": return PipeInfo(false);
                case "pipe.http": return Http(pars);

                case "file.read": return Json.Map("text", FileOps.ReadText(Json.GetString(pars, "path", "")));
                case "file.write": FileOps.WriteText(Json.GetString(pars, "path", ""), Json.GetString(pars, "text", "")); return Json.Map("ok", true);
                case "file.writeAtomic": FileOps.WriteTextAtomic(Json.GetString(pars, "path", ""), Json.GetString(pars, "text", "")); return Json.Map("ok", true);
                case "file.copy": FileOps.WriteText(Json.GetString(pars, "to", ""), FileOps.ReadText(Json.GetString(pars, "from", ""))); return Json.Map("ok", true);
                case "file.copyRaw":
                    {
                        var from = Json.GetString(pars, "from", "");
                        var to = Json.GetString(pars, "to", "");
                        var toDir = Path.GetDirectoryName(to);
                        if (!string.IsNullOrEmpty(toDir)) Directory.CreateDirectory(toDir);
                        File.Copy(from, to, true);
                        return Json.Map("ok", true);
                    }
                case "file.exists": return Json.Map("exists", FileOps.Exists(Json.GetString(pars, "path", "")));
                case "file.delete": FileOps.DeleteFile(Json.GetString(pars, "path", "")); return Json.Map("ok", true);
                case "file.ensureDir": FileOps.EnsureDir(Json.GetString(pars, "path", "")); return Json.Map("ok", true);
                case "file.listFiles": return Json.Map("files", FileOps.ListFiles(Json.GetString(pars, "path", "")));
                case "file.listDirs": return Json.Map("dirs", FileOps.DirectoryNames(Json.GetString(pars, "path", "")));
                case "file.stat": return FileStat(pars);

                case "net.probe": return Json.Map("results", Net.ProbeMany(ToIntArray(Json.Get(pars, "ports"))));

                case "dialog.saveText":
                    {
                        var path = OnUi(delegate ()
                        {
                            return Dialogs.SaveText(
                                Json.GetString(pars, "defaultName", "portpilot-config.json"),
                                Json.GetString(pars, "content", ""),
                                Json.GetString(pars, "filter", null));
                        });
                        return Json.Map("path", path, "canceled", path == null);
                    }
                case "dialog.openText":
                    {
                        var res = OnUi(delegate () { return Dialogs.OpenText(); });
                        return res;
                    }
                case "dialog.confirm":
                    {
                        var ok = OnUi(delegate ()
                        {
                            return Dialogs.Confirm(Json.GetString(pars, "message", ""), Json.GetString(pars, "title", ""));
                        });
                        return Json.Map("ok", ok);
                    }
                case "dialog.info":
                    OnUi(delegate () { Dialogs.Info(Json.GetString(pars, "message", ""), Json.GetString(pars, "title", "")); return 0; });
                    return Json.Map("ok", true);
                case "dialog.pickFolder":
                    {
                        var p = OnUi(delegate () { return Dialogs.PickFolder(Json.GetString(pars, "title", "")); });
                        return Json.Map("path", p, "canceled", p == null);
                    }

                case "shell.reveal":
                    {
                        var target = Json.GetString(pars, "path", "");
                        if (File.Exists(target))
                            Process.Start("explorer.exe", "/select,\"" + target + "\"");
                        else if (Directory.Exists(target))
                            Process.Start("explorer.exe", "\"" + target + "\"");
                        return Json.Map("ok", true);
                    }
                case "shell.open":
                    {
                        var target = Json.GetString(pars, "path", "");
                        Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
                        return Json.Map("ok", true);
                    }

                case "theme.get": return Json.Map("mode", Theme.Mode(), "light", Theme.IsLight());

                default:
                    throw new InvalidOperationException("未知的调用：" + method);
            }
        }

        private object ExitApp()
        {
            try
            {
                _ui.BeginInvoke((Action)delegate ()
                {
                    var form = _ui as Form;
                    if (form != null) form.Close();
                });
            }
            catch { }
            return Json.Map("ok", true);
        }

        private object FileStat(object pars)
        {
            var path = Json.GetString(pars, "path", "");
            return Json.Map(
                "exists", FileOps.Exists(path),
                "size", FileOps.SizeOf(path),
                "modified", FileOps.ModifiedOf(path).ToString("o"));
        }

        private object AppInfo()
        {
            return Json.Map(
                "app", Program.AppName,
                "version", Program.AppVersion,
                "debug", false,
                "exeDir", Paths.ExeDir,
                "webDir", Paths.WebDir,
                "appDataDir", Paths.AppData,
                "backupDir", Paths.BackupRoot,
                "stateFile", Paths.StateFile,
                "runLogFile", Paths.RunLogFile,
                "vergeDir", Paths.VergeData,
                "clashConfigPath", Paths.ClashConfig,
                "profilesYamlPath", Paths.ProfilesYaml,
                "profilesDir", Paths.ProfilesDir,
                "theme", Theme.Mode(),
                "light", Theme.IsLight(),
                "vergeRunning", ProcessRunning("clash-verge"),
                "coreRunning", ProcessRunning("verge-mihomo"),
                "dotnet", Environment.Version.ToString());
        }

        private static bool ProcessRunning(string name)
        {
            try
            {
                var list = Process.GetProcessesByName(name);
                var any = list.Length > 0;
                foreach (var p in list) p.Dispose();
                return any;
            }
            catch { return false; }
        }

        private object PipeInfo(bool force)
        {
            var pipe = PipeHttp.Discover(force);
            var result = new Dictionary<string, object>();
            result["pipe"] = pipe;
            result["error"] = PipeHttp.LastError;
            if (pipe != null)
            {
                PipeHttp.Secret = PipeHttp.DeclaredSecret();
                var v = PipeHttp.RequestOn(pipe, "GET", "/version", null, 2500);
                if (v != null && v.Status == 200)
                {
                    result["version"] = v.Body;
                    result["core"] = true;
                }
                else
                {
                    result["core"] = false;
                    result["version"] = null;
                }
            }
            else
            {
                result["core"] = false;
                result["version"] = null;
            }
            result["secret"] = PipeHttp.Secret;
            return result;
        }

        private object Http(object pars)
        {
            var method = Json.GetString(pars, "method", "GET");
            var path = Json.GetString(pars, "path", "/");
            var body = Json.Get(pars, "body");
            var bodyText = body == null ? null : Json.Stringify(body);
            var timeout = Json.GetInt(pars, "timeout", 20000);

            var resp = PipeHttp.Request(method, path, bodyText, timeout);
            if (resp == null)
            {
                return Json.Map("ok", false, "error", PipeHttp.LastError, "status", 0, "body", "");
            }
            return Json.Map(
                "ok", resp.Ok,
                "status", resp.Status,
                "reason", resp.Reason,
                "body", resp.Body,
                "pipe", PipeHttp.CachedPipe);
        }

        private static int[] ToIntArray(object value)
        {
            var arr = Json.AsArray(value);
            var list = new List<int>();
            foreach (var item in arr)
            {
                try { list.Add(Convert.ToInt32(item)); }
                catch { }
            }
            return list.ToArray();
        }
    }
}
