using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace PortPilot
{
    /// <summary>--selftest：不弹窗、不改配置，只验证宿主能力。结果写入 dist\selftest.txt 并回显控制台。</summary>
    internal static class SelfTest
    {
        internal static int Run()
        {
            Native.AttachParentConsole();
            try { Paths.EnsureAppDirs(); } catch { }
            var lines = new List<string>();
            int failures = 0;

            Action<string, bool, string> check = delegate (string name, bool ok, string detail)
            {
                if (!ok) failures++;
                lines.Add((ok ? "PASS " : "FAIL ") + name + (string.IsNullOrEmpty(detail) ? "" : "  :: " + detail));
            };

            Action<string, string> skip = delegate (string name, string detail)
            {
                lines.Add("SKIP " + name + (string.IsNullOrEmpty(detail) ? "" : "  :: " + detail));
            };

            // 1. 路径
            check("paths.appdata", Directory.Exists(Paths.AppData), Paths.AppData);
            check("paths.web", File.Exists(Paths.IndexHtml), Paths.IndexHtml);
            check("paths.clashConfig", File.Exists(Paths.ClashConfig), Paths.ClashConfig);

            // 2. 界面资源
            var appJs = Path.Combine(Paths.WebDir, "js", "app.js");
            var appCss = Path.Combine(Paths.WebDir, "css", "app.css");
            check("web.appjs", File.Exists(appJs), appJs);
            check("web.appcss", File.Exists(appCss), appCss);
            var sharedApi = Path.Combine(Paths.WebDir, "shared", "api.js");
            check("web.shared", File.Exists(sharedApi), sharedApi);

            // 3. Clash Verge 与内核
            bool vergeRunning = System.Diagnostics.Process.GetProcessesByName("clash-verge").Length > 0;
            lines.Add((vergeRunning ? "PASS " : "SKIP ") + "verge.process  :: " +
                      (vergeRunning ? "Clash Verge 正在运行" : "Clash Verge 未运行"));

            var pipe = PipeHttp.Discover(true);
            if (pipe == null)
            {
                skip("core.pipe", PipeHttp.LastError);
                skip("core.version", "没有管道");
                skip("core.configs", "没有管道");
            }
            else
            {
                check("core.pipe", true, pipe);
                PipeHttp.Secret = PipeHttp.DeclaredSecret();
                var v = PipeHttp.RequestOn(pipe, "GET", "/version", null, 4000);
                check("core.version", v != null && v.Status == 200,
                    v == null ? "无响应" : (v.Status + " " + Trim(v.Body, 80)));
                if (v != null && v.Status == 200)
                {
                    var c = PipeHttp.RequestOn(pipe, "GET", "/configs", null, 6000);
                    check("core.configs", c != null && c.Status == 200,
                        c == null ? "无响应" : (c.Status + " len=" + (c.Body == null ? 0 : c.Body.Length)));
                    if (c != null && c.Status == 200)
                    {
                        var map = Json.AsMap(Json.Parse(c.Body));
                        var mixed = Json.GetInt(map, "mixed-port", 0);
                        lines.Add("INFO core.mixedPort  :: " + mixed);
                        if (mixed > 0)
                        {
                            check("net.probeListening", Net.TcpProbe(mixed, 500),
                                "127.0.0.1:" + mixed + " 应当可连接");
                        }
                    }
                }
            }

            // 4. 文件原语（在 AppData 内做，避免污染）
            try
            {
                var probeDir = Path.Combine(Paths.AppData, "selftest");
                Directory.CreateDirectory(probeDir);
                var target = Path.Combine(probeDir, "sample.txt");
                var backup = Path.Combine(probeDir, "sample.bak");
                FileOps.WriteTextAtomic(target, "第一版\r\n");
                var ok1 = FileOps.ReadText(target) == "第一版\r\n";
                FileOps.Backup(target, probeDir, "sample.bak");
                FileOps.WriteTextAtomic(target, "第二版\r\n");
                FileOps.Restore(backup, target);
                var ok2 = FileOps.ReadText(target) == "第一版\r\n";
                check("file.atomicWrite", ok1, "写入后回读一致（含中文）");
                check("file.backupRestore", ok2, "备份与还原一致");
                check("file.noBom", File.ReadAllBytes(target)[0] != 0xEF, "写出的文件不带 BOM");
            }
            catch (Exception ex)
            {
                check("file.atomicWrite", false, ex.Message);
            }

            // 5. 端口探测
            try
            {
                var busy = Net.Probe(1); // 1 号端口通常无监听，主要验证不抛异常
                check("net.probeApi", busy.ContainsKey("listening") && busy.ContainsKey("bindable"), "probe 返回结构正确");
            }
            catch (Exception ex)
            {
                check("net.probeApi", false, ex.Message);
            }

            // 6. 主题
            try
            {
                check("theme.read", true, "当前 " + Theme.Mode());
            }
            catch (Exception ex)
            {
                check("theme.read", false, ex.Message);
            }

            // 7. JSON
            try
            {
                var text = Json.Stringify(Json.Map("a", 1, "b", "中文"));
                var back = Json.AsMap(Json.Parse(text));
                check("json.roundtrip", Json.GetInt(back, "a", 0) == 1 && Json.GetString(back, "b", "") == "中文", text);
            }
            catch (Exception ex)
            {
                check("json.roundtrip", false, ex.Message);
            }

            lines.Add("");
            lines.Add(failures == 0 ? "结果：全部通过" : ("结果：有 " + failures + " 项失败"));

            var report = string.Join(Environment.NewLine, lines.ToArray());
            var logPath = Path.Combine(Paths.ExeDir, "selftest.txt");
            try { File.WriteAllText(logPath, report, new UTF8Encoding(false)); } catch { }
            try { Console.WriteLine(report); } catch { }
            return failures == 0 ? 0 : 1;
        }

        private static string Trim(string text, int max)
        {
            if (string.IsNullOrEmpty(text)) return "";
            text = text.Replace("\r", " ").Replace("\n", " ");
            return text.Length <= max ? text : text.Substring(0, max) + "…";
        }
    }
}
