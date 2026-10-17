using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace PortPilot
{
    internal sealed class PipeResponse
    {
        internal int Status;
        internal string Reason = "";
        internal string Body = "";
        internal string Raw = "";
        internal bool Ok { get { return Status >= 200 && Status < 300; } }
    }

    /// <summary>
    /// 在 mihomo 的命名管道上手写 HTTP/1.1。
    /// 管道名优先取配置里的 external-controller-pipe，并把 sidecar-release- 换成实际可连的 production-。
    /// </summary>
    internal static class PipeHttp
    {
        private static readonly object Gate = new object();
        private static string _cachedPipe;
        private static string _secret = "";
        private static string _lastError = "";
        private static readonly UTF8Encoding Utf8NoBom = new UTF8Encoding(false);

        internal const string PipePrefix = @"\\.\pipe\";

        internal static string CachedPipe
        {
            get { lock (Gate) return _cachedPipe; }
        }

        internal static string LastError
        {
            get { lock (Gate) return _lastError; }
        }

        internal static string Secret
        {
            get { lock (Gate) return _secret; }
            set { lock (Gate) _secret = value ?? ""; }
        }

        internal static void ForgetPipe()
        {
            lock (Gate) _cachedPipe = null;
        }

        internal static string ShortName(string pipePath)
        {
            if (string.IsNullOrEmpty(pipePath)) return pipePath;
            if (pipePath.StartsWith(PipePrefix, StringComparison.OrdinalIgnoreCase))
                return pipePath.Substring(PipePrefix.Length);
            return pipePath.TrimStart('\\');
        }

        private static string DeclaredPipe()
        {
            try
            {
                if (!File.Exists(Paths.ClashConfig)) return null;
                var text = FileOps.ReadText(Paths.ClashConfig);
                var m = Regex.Match(text, @"^\s*external-controller-pipe:\s*(.+?)\s*$", RegexOptions.Multiline);
                if (!m.Success) return null;
                var value = m.Groups[1].Value.Trim().Trim('\'', '"');
                if (value.Length == 0) return null;
                return value;
            }
            catch { return null; }
        }

        internal static string DeclaredSecret()
        {
            try
            {
                if (!File.Exists(Paths.ClashConfig)) return "";
                var text = FileOps.ReadText(Paths.ClashConfig);
                var m = Regex.Match(text, @"^\s*secret:\s*(.+?)\s*$", RegexOptions.Multiline);
                if (!m.Success) return "";
                return m.Groups[1].Value.Trim().Trim('\'', '"');
            }
            catch { return ""; }
        }

        private static List<string> Candidates()
        {
            var list = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            Action<string> add = delegate (string p)
            {
                if (string.IsNullOrEmpty(p)) return;
                if (seen.Add(p)) list.Add(p);
            };

            var declared = DeclaredPipe();
            if (declared != null)
            {
                add(declared);
                if (declared.IndexOf("sidecar-release-", StringComparison.OrdinalIgnoreCase) >= 0)
                    add(Regex.Replace(declared, "sidecar-release-", "production-", RegexOptions.IgnoreCase));
                if (declared.IndexOf("production-", StringComparison.OrdinalIgnoreCase) >= 0)
                    add(Regex.Replace(declared, "production-", "sidecar-release-", RegexOptions.IgnoreCase));
            }

            try
            {
                var files = Directory.GetFiles(PipePrefix);
                var mihomo = new List<string>();
                foreach (var f in files)
                {
                    var name = ShortName(f);
                    if (name.IndexOf("mihomo", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        name.IndexOf("clash", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        mihomo.Add(f);
                    }
                }
                // production- 变体优先
                mihomo.Sort(delegate (string a, string b)
                {
                    int ra = a.IndexOf("production-", StringComparison.OrdinalIgnoreCase) >= 0 ? 0 : 1;
                    int rb = b.IndexOf("production-", StringComparison.OrdinalIgnoreCase) >= 0 ? 0 : 1;
                    if (ra != rb) return ra.CompareTo(rb);
                    return string.Compare(a, b, StringComparison.OrdinalIgnoreCase);
                });
                foreach (var p in mihomo) add(p);
            }
            catch { }

            return list;
        }

        /// <summary>发现可用管道；成功返回完整管道路径。</summary>
        internal static string Discover(bool force)
        {
            lock (Gate)
            {
                if (!force && _cachedPipe != null) return _cachedPipe;
            }

            var candidates = Candidates();
            string alive = null;
            foreach (var c in candidates)
            {
                var r = RequestOn(c, "GET", "/version", null, 1500);
                if (r != null && r.Status == 200)
                {
                    alive = c;
                    break;
                }
            }

            lock (Gate)
            {
                _cachedPipe = alive;
                if (alive == null)
                    _lastError = candidates.Count == 0
                        ? "没有找到 Clash Verge 内核管道（Clash Verge 可能没有运行）"
                        : "找到了 " + candidates.Count + " 个候选管道，但都连不上（Clash Verge 可能正在启动）";
            }
            return alive;
        }

        internal static PipeResponse Request(string method, string path, string body, int timeoutMs)
        {
            var pipe = Discover(false);
            if (pipe == null) return null;
            var r = RequestOn(pipe, method, path, body, timeoutMs);
            if (r == null)
            {
                // 缓存失效，重新发现一次
                ForgetPipe();
                pipe = Discover(true);
                if (pipe == null) return null;
                r = RequestOn(pipe, method, path, body, timeoutMs);
            }
            return r;
        }

        internal static PipeResponse RequestOn(string pipePath, string method, string path, string body, int timeoutMs)
        {
            NamedPipeClientStream client = null;
            try
            {
                client = new NamedPipeClientStream(".", ShortName(pipePath),
                    PipeDirection.InOut, PipeOptions.None);
                client.Connect(Math.Min(timeoutMs, 4000));

                byte[] bodyBytes = body == null ? new byte[0] : Utf8NoBom.GetBytes(body);
                var head = new StringBuilder();
                head.Append(method).Append(' ').Append(path).Append(" HTTP/1.1\r\n");
                head.Append("Host: localhost\r\n");
                var secret = Secret;
                if (!string.IsNullOrEmpty(secret))
                    head.Append("Authorization: Bearer ").Append(secret).Append("\r\n");
                if (bodyBytes.Length > 0)
                    head.Append("Content-Type: application/json; charset=utf-8\r\n");
                head.Append("Content-Length: ").Append(bodyBytes.Length).Append("\r\n");
                head.Append("Connection: close\r\n\r\n");

                var headBytes = Encoding.ASCII.GetBytes(head.ToString());
                client.Write(headBytes, 0, headBytes.Length);
                if (bodyBytes.Length > 0) client.Write(bodyBytes, 0, bodyBytes.Length);
                client.Flush();

                var raw = ReadAll(client, timeoutMs);
                var parsed = Parse(raw);
                return parsed;
            }
            catch (Exception ex)
            {
                lock (Gate) { _lastError = ex.Message; }
                return null;
            }
            finally
            {
                if (client != null)
                {
                    try { client.Dispose(); } catch { }
                }
            }
        }

        private static byte[] ReadAll(Stream stream, int timeoutMs)
        {
            var ms = new MemoryStream();
            Exception error = null;
            var t = new Thread(delegate ()
            {
                try
                {
                    var buf = new byte[16384];
                    int n;
                    while ((n = stream.Read(buf, 0, buf.Length)) > 0) ms.Write(buf, 0, n);
                }
                catch (Exception ex) { error = ex; }
            });
            t.IsBackground = true;
            t.Start();
            if (!t.Join(timeoutMs))
            {
                throw new TimeoutException("等待内核响应超时（" + timeoutMs + " 毫秒）");
            }
            if (error != null) throw error;
            return ms.ToArray();
        }

        private static PipeResponse Parse(byte[] raw)
        {
            var resp = new PipeResponse();
            resp.Raw = Encoding.UTF8.GetString(raw);
            int sep = IndexOf(raw, new byte[] { 13, 10, 13, 10 });
            if (sep < 0)
            {
                resp.Status = 0;
                resp.Body = resp.Raw;
                return resp;
            }

            var headText = Encoding.ASCII.GetString(raw, 0, sep);
            var lines = headText.Split(new[] { "\r\n" }, StringSplitOptions.None);
            if (lines.Length > 0)
            {
                var parts = lines[0].Split(' ');
                if (parts.Length >= 2)
                {
                    int code;
                    if (int.TryParse(parts[1], out code)) resp.Status = code;
                    if (parts.Length >= 3) resp.Reason = string.Join(" ", parts, 2, parts.Length - 2);
                }
            }

            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 1; i < lines.Length; i++)
            {
                int c = lines[i].IndexOf(':');
                if (c <= 0) continue;
                headers[lines[i].Substring(0, c).Trim()] = lines[i].Substring(c + 1).Trim();
            }

            int bodyStart = sep + 4;
            string chunked;
            if (headers.TryGetValue("Transfer-Encoding", out chunked) &&
                chunked.IndexOf("chunked", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                resp.Body = DecodeChunked(raw, bodyStart);
                return resp;
            }

            string lenText;
            if (headers.TryGetValue("Content-Length", out lenText))
            {
                int len;
                if (int.TryParse(lenText, out len))
                {
                    if (bodyStart + len > raw.Length) len = raw.Length - bodyStart;
                    resp.Body = len <= 0 ? "" : Encoding.UTF8.GetString(raw, bodyStart, len);
                    return resp;
                }
            }

            resp.Body = bodyStart >= raw.Length ? "" : Encoding.UTF8.GetString(raw, bodyStart, raw.Length - bodyStart);
            return resp;
        }

        private static string DecodeChunked(byte[] raw, int start)
        {
            var sb = new StringBuilder();
            int i = start;
            while (i < raw.Length)
            {
                int lineEnd = IndexOf(raw, new byte[] { 13, 10 }, i);
                if (lineEnd < 0) break;
                var sizeText = Encoding.ASCII.GetString(raw, i, lineEnd - i);
                int semi = sizeText.IndexOf(';');
                if (semi >= 0) sizeText = sizeText.Substring(0, semi);
                int size;
                if (!int.TryParse(sizeText.Trim(), System.Globalization.NumberStyles.HexNumber, null, out size)) break;
                i = lineEnd + 2;
                if (size == 0) break;
                if (i + size > raw.Length) size = raw.Length - i;
                sb.Append(Encoding.UTF8.GetString(raw, i, size));
                i += size + 2;
            }
            return sb.ToString();
        }

        private static int IndexOf(byte[] haystack, byte[] needle, int from)
        {
            if (needle.Length == 0) return -1;
            for (int i = Math.Max(0, from); i <= haystack.Length - needle.Length; i++)
            {
                bool match = true;
                for (int j = 0; j < needle.Length; j++)
                {
                    if (haystack[i + j] != needle[j]) { match = false; break; }
                }
                if (match) return i;
            }
            return -1;
        }

        private static int IndexOf(byte[] haystack, byte[] needle)
        {
            return IndexOf(haystack, needle, 0);
        }
    }
}
