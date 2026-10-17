using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;

namespace PortPilot
{
    /// <summary>端口探测：连通性（是否真的在监听）与可绑定性。</summary>
    internal static class Net
    {
        private const string Loopback = "127.0.0.1";

        internal static bool TcpProbe(int port, int timeoutMs)
        {
            var client = new TcpClient();
            try
            {
                var ar = client.BeginConnect(IPAddress.Loopback, port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(timeoutMs)) return false;
                client.EndConnect(ar);
                return true;
            }
            catch
            {
                return false;
            }
            finally
            {
                try { client.Close(); } catch { }
            }
        }

        /// <summary>返回 { listening, bindable }：listening 表示有人在监听，bindable 表示本进程能同时绑到回环。</summary>
        internal static Dictionary<string, object> Probe(int port)
        {
            bool listening = TcpProbe(port, 350);
            bool bindable = CanBindTcp(port) && CanBindUdp(port);
            return Json.Map("port", port, "listening", listening, "bindable", bindable);
        }

        internal static bool CanBindTcp(int port)
        {
            TcpListener listener = null;
            try
            {
                listener = new TcpListener(IPAddress.Loopback, port);
                listener.ExclusiveAddressUse = true;
                listener.Start();
                return true;
            }
            catch { return false; }
            finally { try { if (listener != null) listener.Stop(); } catch { } }
        }

        internal static bool CanBindUdp(int port)
        {
            UdpClient udp = null;
            try
            {
                udp = new UdpClient(new IPEndPoint(IPAddress.Loopback, port));
                return true;
            }
            catch { return false; }
            finally { try { if (udp != null) udp.Close(); } catch { } }
        }

        internal static List<Dictionary<string, object>> ProbeMany(int[] ports)
        {
            var result = new List<Dictionary<string, object>>();
            if (ports == null) return result;
            foreach (var p in ports) result.Add(Probe(p));
            return result;
        }

        internal static string LocalAddress { get { return Loopback; } }
    }
}
