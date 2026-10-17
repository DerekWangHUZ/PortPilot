using System;
using Microsoft.Win32;

namespace PortPilot
{
    /// <summary>跟随系统的深色/浅色判定，并转发系统变化。</summary>
    internal static class Theme
    {
        private static bool _hooked;
        private static bool _lastLight;

        internal const string PersonalizeKey = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

        internal static bool IsLight()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(PersonalizeKey))
                {
                    if (key == null) return false;
                    var v = key.GetValue("AppsUseLightTheme");
                    if (v == null) return false;
                    return Convert.ToInt32(v) != 0;
                }
            }
            catch { return false; }
        }

        internal static string Mode()
        {
            return IsLight() ? "light" : "dark";
        }

        /// <summary>订阅系统主题变化；回调在 UI 线程外触发，调用方自行切线程。</summary>
        internal static void StartWatching(Action<string> onChange)
        {
            if (_hooked) return;
            _hooked = true;
            _lastLight = IsLight();
            try
            {
                SystemEvents.UserPreferenceChanged += delegate (object sender, UserPreferenceChangedEventArgs e)
                {
                    var now = IsLight();
                    if (now == _lastLight) return;
                    _lastLight = now;
                    if (onChange != null)
                    {
                        try { onChange(now ? "light" : "dark"); }
                        catch { }
                    }
                };
            }
            catch { }
        }
    }
}
