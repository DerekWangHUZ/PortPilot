using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Web.Script.Serialization;

namespace PortPilot
{
    /// <summary>宿主侧的最小 JSON 工具（基于 .NET Framework 自带的 JavaScriptSerializer）。</summary>
    internal static class Json
    {
        private static readonly JavaScriptSerializer Serializer = CreateSerializer();

        private static JavaScriptSerializer CreateSerializer()
        {
            var s = new JavaScriptSerializer();
            s.MaxJsonLength = int.MaxValue;
            s.RecursionLimit = 200;
            return s;
        }

        internal static object Parse(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            return Serializer.DeserializeObject(text);
        }

        internal static string Stringify(object value)
        {
            return Serializer.Serialize(value);
        }

        internal static Dictionary<string, object> AsMap(object value)
        {
            return value as Dictionary<string, object>;
        }

        internal static object[] AsArray(object value)
        {
            if (value == null) return new object[0];
            var arr = value as object[];
            if (arr != null) return arr;
            var list = value as ArrayList;
            if (list != null) return list.ToArray();
            var enumerable = value as IEnumerable;
            if (enumerable == null) return new object[0];
            var result = new List<object>();
            foreach (var item in enumerable) result.Add(item);
            return result.ToArray();
        }

        internal static object Get(object map, string key)
        {
            var m = map as Dictionary<string, object>;
            if (m == null) return null;
            object v;
            return m.TryGetValue(key, out v) ? v : null;
        }

        internal static string GetString(object map, string key, string fallback)
        {
            var v = Get(map, key);
            if (v == null) return fallback;
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        internal static int GetInt(object map, string key, int fallback)
        {
            var v = Get(map, key);
            if (v == null) return fallback;
            try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); }
            catch { return fallback; }
        }

        internal static bool GetBool(object map, string key, bool fallback)
        {
            var v = Get(map, key);
            if (v == null) return fallback;
            if (v is bool) return (bool)v;
            bool parsed;
            if (bool.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), out parsed)) return parsed;
            return fallback;
        }

        /// <summary>把任意对象转成可序列化的普通结构，避免循环引用。</summary>
        internal static Dictionary<string, object> Map(params object[] pairs)
        {
            var d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < pairs.Length; i += 2)
            {
                d[Convert.ToString(pairs[i], CultureInfo.InvariantCulture)] = pairs[i + 1];
            }
            return d;
        }
    }
}
