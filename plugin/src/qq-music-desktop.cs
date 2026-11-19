using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;

internal static class QQMusicDesktop
{
    private static readonly string ClientPath = Environment.GetEnvironmentVariable("SURFCORE_QQ_MUSIC_EXE");
    private const string QualityLabel = "HQ高品质";
    private static readonly TimeSpan ScanInterval = TimeSpan.FromMilliseconds(260);
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private sealed class Unavailable : Exception
    {
        internal Unavailable(string message) : base(message) { }
    }

    private sealed class Track
    {
        internal string Title;
        internal string Artist;
        internal int DurationSeconds;
        internal AutomationElement TitleLink;
    }

    [MTAThread]
    private static int Main(string[] args)
    {
        Console.OutputEncoding = Utf8;
        try
        {
            if (args.Length >= 1 && args.Length <= 2 && args[0] == "--diagnose")
            {
                var requestedTitle = args.Length == 2 ? Decode(args[1]) : null;
                EnableDpiAwareness();
                using (var client = GetClient()) Diagnose(client, requestedTitle);
                return 0;
            }
            var inspect = args.Length > 0 && args[0] == "--inspect";
            var first = inspect ? 1 : 0;
            if (args.Length - first < 2 || args.Length - first > 3)
                throw new Unavailable("需要歌名与歌手的 UTF-8 Base64 参数。");
            var title = Decode(args[first]);
            var artist = Decode(args[first + 1]);
            var excludedArtists = args.Length - first == 3 ? DecodeExcludedArtists(args[first + 2]) : new HashSet<string>();
            if (Normalize(title).Length == 0 || (artist.Length > 0 && Normalize(artist).Length == 0))
                throw new Unavailable("歌名或歌手格式无效。");

            EnableDpiAwareness();
            using (var client = GetClient())
            {
                var window = MainWindow(client);
                Activate(client, window);
                var main = AutomationElement.FromHandle(window);
                var search = FindSearch(client, main);
                var preferFemale = artist.Length == 0 && !HasVersionQualifier(title);
                SubmitSearch(client, window, search, preferFemale ? title + " 女声" : title);
                var track = FindTrack(main, title, artist, excludedArtists);
                if (!inspect) Download(client, window, track);
                Console.WriteLine(Json.Serialize(new { title = track.Title, artist = track.Artist, durationSeconds = track.DurationSeconds }));
                return 0;
            }
        }
        catch (Unavailable error)
        {
            Console.Error.WriteLine(error.Message);
            return 2;
        }
        catch (ElementNotAvailableException)
        {
            Console.Error.WriteLine("QQ 音乐界面已切换，请稍后再试。");
            return 2;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("QQ 音乐桌面助手失败（" + error.GetType().Name + "）。");
            return 1;
        }
    }

    private static string Decode(string value)
    {
        try
        {
            if (value.Length > 540) throw new FormatException();
            var input = Utf8.GetString(Convert.FromBase64String(value)).Trim();
            if (input.Length > 100 || input.Any(char.IsControl)) throw new FormatException();
            return input;
        }
        catch (Exception error)
        {
            if (!(error is FormatException) && !(error is DecoderFallbackException)) throw;
            throw new Unavailable("歌名或歌手格式无效。");
        }
    }

    private static HashSet<string> DecodeExcludedArtists(string value)
    {
        try
        {
            if (value.Length > 24576) throw new FormatException();
            var entries = Json.DeserializeObject(Utf8.GetString(Convert.FromBase64String(value))) as object[];
            if (entries == null || entries.Length > 50 || entries.Any(entry => !(entry is string)))
                throw new FormatException();
            var artists = entries.Cast<string>().ToArray();
            if (artists.Any(artist => string.IsNullOrWhiteSpace(artist) || artist.Length > 100 || artist.Any(char.IsControl)))
                throw new FormatException();
            return new HashSet<string>(artists.Select(Normalize));
        }
        catch (Exception error)
        {
            if (!(error is ArgumentException) && !(error is FormatException) && !(error is InvalidOperationException)) throw;
            throw new Unavailable("排除歌手列表格式无效。");
        }
    }

    private static string Normalize(string value)
    {
        var normalized = value.Normalize(NormalizationForm.FormKC).ToUpperInvariant();
        return Regex.Replace(Regex.Replace(normalized, "['’‘]", ""), @"[^\p{L}\p{N}]+", " ").Trim();
    }

    private static bool HasVersionQualifier(string title)
    {
        return Regex.IsMatch(title,
            @"(?:[（(][^）)]*(?:版|翻唱|现场|伴奏|live|remix|cover|ver(?:sion)?|instrumental|original)[^）)]*[）)]|(?:女声|男声|翻唱|现场|伴奏|\b(?:live|remix|cover|instrumental)\b))",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }

    private static Process GetClient()
    {
        var candidates = new List<Process>();
        foreach (var process in Process.GetProcessesByName("QQMusic"))
        {
            try
            {
                var module = process.MainModule;
                if (process.MainWindowHandle != IntPtr.Zero &&
                    module != null && string.Equals(module.FileName, ClientPath, StringComparison.OrdinalIgnoreCase) &&
                    module.FileVersionInfo.FileVersion == "18.44.0")
                {
                    candidates.Add(process);
                    continue;
                }
            }
            catch (System.ComponentModel.Win32Exception) { }
            catch (InvalidOperationException) { }
            process.Dispose();
        }
        if (candidates.Count == 1) return candidates[0];
        foreach (var candidate in candidates) candidate.Dispose();
        throw new Unavailable("请保持已登录的 QQ 音乐 18.44.0 客户端窗口打开。");
    }

    private static IEnumerable<AutomationElement> Find(AutomationElement root, Condition condition)
    {
        return root.FindAll(TreeScope.Descendants, condition).Cast<AutomationElement>();
    }

    private static IEnumerable<IntPtr> ClientWindows(Process client)
    {
        var windows = new List<IntPtr>();
        EnumWindows(delegate(IntPtr window, IntPtr unused)
        {
            if (IsWindowVisible(window) && IsClientWindow(client, window)) windows.Add(window);
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    private static IntPtr MainWindow(Process client)
    {
        var windows = ClientWindows(client).Where(window => WindowClass(window) == "TXGuiFoundation")
            .Select(window => new { window = window, area = MainWindowArea(window) })
            .OrderByDescending(window => window.area).ToArray();
        if (windows.Length == 0 || windows[0].area < 200000)
            throw new Unavailable("找不到 QQ 音乐的主窗口。");
        return windows[0].window;
    }

    private static long MainWindowArea(IntPtr window)
    {
        NativeRect bounds;
        if (IsIconic(window))
        {
            // A minimized window's screen rectangle contains only its icon dimensions.
            var placement = new WindowPlacement { Length = Marshal.SizeOf(typeof(WindowPlacement)) };
            if (!GetWindowPlacement(window, ref placement)) return 0;
            bounds = placement.NormalPosition;
        }
        else if (!GetWindowRect(window, out bounds)) return 0;
        var width = (long)bounds.Right - bounds.Left;
        var height = (long)bounds.Bottom - bounds.Top;
        return width > 0 && height > 0 ? width * height : 0;
    }

    private static void Diagnose(Process client, string requestedTitle)
    {
        var windows = new List<object>();
        foreach (var window in ClientWindows(client))
        {
            var root = AutomationElement.FromHandle(window);
            var candidates = Find(root, new OrCondition(Type(ControlType.Edit),
                Name("听歌识曲"), Name("后退"), Name("下载"), Name(QualityLabel))).Take(30).Select(item =>
            {
                var value = item.Current;
                var rectangle = value.BoundingRectangle;
                return new
                {
                    name = value.Name, className = value.ClassName, id = value.AutomationId,
                    enabled = value.IsEnabled, offscreen = value.IsOffscreen, focusable = value.IsKeyboardFocusable,
                    bounds = rectangle.ToString(CultureInfo.InvariantCulture),
                    patterns = item.GetSupportedPatterns().Select(pattern => pattern.ProgrammaticName).ToArray(),
                };
            }).ToArray();
            var children = new List<object>();
            EnumChildWindows(window, delegate(IntPtr child, IntPtr unused)
            {
                if (children.Count >= 35) return false;
                if (IsWindowVisible(child)) children.Add(new { handle = child.ToString("X"), className = WindowClass(child) });
                return true;
            }, IntPtr.Zero);
            NativeRect bounds;
            GetWindowRect(window, out bounds);
            var exactRows = requestedTitle == null ? null : Find(root, Type(ControlType.Hyperlink))
                .Where(link => Visible(link) && Normalize(link.Current.Name) == Normalize(requestedTitle))
                .Take(12).Select(link =>
                {
                    var track = Identify(link);
                    return new { title = link.Current.Name, artist = track == null ? null : track.Artist,
                        durationSeconds = track == null ? (int?)null : track.DurationSeconds };
                }).ToArray();
            windows.Add(new { handle = window.ToString("X"), main = window == client.MainWindowHandle,
                className = WindowClass(window), owner = GetWindow(window, 4).ToString("X"),
                bounds = new[] { bounds.Left, bounds.Top, bounds.Right, bounds.Bottom },
                candidates = candidates, children = children, exactRows = exactRows });
        }
        Console.WriteLine(Json.Serialize(new { pid = client.Id, windows = windows }));
    }

    private static string WindowClass(IntPtr window)
    {
        var text = new StringBuilder(256);
        GetClassName(window, text, text.Capacity);
        return text.ToString();
    }

    private static Condition Type(ControlType type)
    {
        return new PropertyCondition(AutomationElement.ControlTypeProperty, type);
    }

    private static Condition Name(string name)
    {
        return new PropertyCondition(AutomationElement.NameProperty, name);
    }

    private static bool Visible(AutomationElement element)
    {
        var bounds = element.Current.BoundingRectangle;
        return !element.Current.IsOffscreen && !bounds.IsEmpty && bounds.Width > 0 && bounds.Height > 0;
    }

    private static AutomationElement FindSearch(Process client, AutomationElement main)
    {
        var limit = Stopwatch.StartNew();
        var closedPopup = false;
        while (limit.Elapsed < TimeSpan.FromSeconds(4))
        {
            var search = SearchControl(main);
            if (search != null) return search;
            if (!closedPopup && limit.Elapsed > TimeSpan.FromMilliseconds(900))
            {
                EnsureForeground(client);
                SendKeys(Key(0x1B), Key(0x1B, 2));
                closedPopup = true;
            }
            Thread.Sleep(ScanInterval);
        }
        throw new Unavailable("QQ 音乐的搜索框不可用。");
    }

    private static AutomationElement SearchControl(AutomationElement main)
    {
        var indicators = Find(main, new OrCondition(Name("听歌识曲"), Name("後退"), Name("后退"))).ToArray();
        var edits = Find(main, Type(ControlType.Edit))
            .Where(edit => Visible(edit) && edit.Current.IsEnabled)
            .GroupBy(edit => edit.Current.BoundingRectangle).Select(group => group.First()).ToArray();
        var search = edits.Where(edit =>
        {
            var position = edit.Current.BoundingRectangle;
            return indicators.Any(indicator =>
            {
                var reference = indicator.Current.BoundingRectangle;
                return !reference.IsEmpty && Math.Abs(reference.Top + reference.Height / 2 - position.Top - position.Height / 2) < 28;
            });
        }).ToArray();
        if (search.Length == 1) return search[0];
        var named = edits.Where(edit => edit.Current.Name.IndexOf("搜索", StringComparison.Ordinal) >= 0).ToArray();
        if (named.Length == 1) return named[0];
        if (edits.Length == 1) return edits[0];
        return null;
    }

    private static void SubmitSearch(Process client, IntPtr window, AutomationElement search, string title)
    {
        Activate(client, window);
        Click(client, search.Current.BoundingRectangle, false);
        Thread.Sleep(120);
        EnsureForeground(client);
        var query = title;
        object pattern;
        if (!search.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || ((ValuePattern)pattern).Current.IsReadOnly)
            throw new Unavailable("无法确认 QQ 音乐已接收搜索词。");
        var value = (ValuePattern)pattern;
        SendKeys(Key(0x11), Key(0x41), Key(0x41, 2), Key(0x11, 2));
        SendKeys(query.SelectMany(character => new[] { Key(0, 4, character), Key(0, 6, character) }).ToArray());
        Thread.Sleep(180);
        if (value.Current.Value != query)
        {
            EnsureForeground(client);
            value.SetValue(query);
            Thread.Sleep(180);
            if (value.Current.Value != query) throw new Unavailable("QQ 音乐未接收搜索词。");
        }
        EnsureForeground(client);
        SendKeys(Key(0x0D), Key(0x0D, 2));
    }

    private static Track FindTrack(AutomationElement main, string title, string artist, HashSet<string> excludedArtists)
    {
        var titleKey = Normalize(title);
        var artistKey = Normalize(artist);
        var preferFemale = artistKey.Length == 0 && !HasVersionQualifier(title);
        var limit = Stopwatch.StartNew();
        Track[] tracks = new Track[0];
        string previous = null;
        var stable = TimeSpan.Zero;
        Thread.Sleep(1000);
        while (limit.Elapsed < TimeSpan.FromSeconds(12))
        {
            try
            {
                tracks = Find(main, Type(ControlType.Hyperlink))
                    .Where(link => Visible(link) && (preferFemale || Normalize(link.Current.Name) == titleKey))
                    .Select(Identify)
                    .Where(track => track != null && (artistKey.Length == 0 || Normalize(track.Artist) == artistKey) &&
                        (!preferFemale || !excludedArtists.Contains(Normalize(track.Artist))))
                    .OrderBy(track => track.TitleLink.Current.BoundingRectangle.Top)
                    .ThenBy(track => track.TitleLink.Current.BoundingRectangle.Left)
                    .ToArray();
                var signature = string.Join("|", tracks.Select(track => string.Join(".", track.TitleLink.GetRuntimeId())));
                if (signature != previous)
                {
                    previous = signature;
                    stable = limit.Elapsed;
                }
                if (tracks.Length > 0 && limit.Elapsed - stable >= TimeSpan.FromMilliseconds(850))
                {
                    if (artistKey.Length == 0 || tracks.Length == 1) return tracks[0];
                    throw new Unavailable("QQ 音乐有多份匹配的录音，请指定歌手或版本。");
                }
            }
            catch (ElementNotAvailableException) { }
            Thread.Sleep(ScanInterval);
        }
        throw new Unavailable(preferFemale ? "QQ 音乐没有显示可用的女声搜索结果，可以点名歌手或版本。" :
            "QQ 音乐没有显示唯一的匹配录音，或这个版本需要进一步确认。");
    }

    private static Track Identify(AutomationElement title)
    {
        var row = TreeWalker.ControlViewWalker.GetParent(title);
        for (int level = 0; row != null && level < 8; level++, row = TreeWalker.ControlViewWalker.GetParent(row))
        {
            var artists = Find(row, Type(ControlType.Hyperlink)).Where(link =>
                Visible(link) && (link.Current.Name.StartsWith("歌手：", StringComparison.Ordinal) ||
                link.Current.Name.StartsWith("歌手:", StringComparison.Ordinal))).ToArray();
            if (artists.Length > 1) return null;
            if (artists.Length == 0) continue;
            var times = Find(row, Type(ControlType.Text)).Where(Visible)
                .Select(label => Regex.Match(label.Current.Name, @"^时长[：:]\s*([0-9]{1,4}):([0-5][0-9])$"))
                .Where(match => match.Success).Take(2).ToArray();
            if (times.Length != 1) continue;
            // Song rows also expose artist and album links; only their leftmost link is the title.
            var firstLink = Find(row, Type(ControlType.Hyperlink)).Where(Visible)
                .OrderBy(link => link.Current.BoundingRectangle.Left).FirstOrDefault();
            if (firstLink == null || !firstLink.GetRuntimeId().SequenceEqual(title.GetRuntimeId())) return null;
            var duration = int.Parse(times[0].Groups[1].Value, CultureInfo.InvariantCulture) * 60 +
                int.Parse(times[0].Groups[2].Value, CultureInfo.InvariantCulture);
            var artist = artists[0].Current.Name.Substring(3).Trim();
            if (Normalize(artist).Length == 0) return null;
            return new Track { Title = title.Current.Name.Trim(), Artist = artist, DurationSeconds = duration, TitleLink = title };
        }
        return null;
    }

    private static void Download(Process client, IntPtr window, Track track)
    {
        EnsureForeground(client);
        var title = track.TitleLink.Current;
        var checkedTrack = Visible(track.TitleLink) ? Identify(track.TitleLink) : null;
        if (checkedTrack == null || checkedTrack.Title != track.Title || checkedTrack.Artist != track.Artist ||
            checkedTrack.DurationSeconds != track.DurationSeconds)
            throw new Unavailable("选中的歌曲结果已改变。");
        var previousWindows = new HashSet<IntPtr>(ClientWindows(client).Where(popup => popup != window));
        Click(client, title.BoundingRectangle, true);
        var menu = WaitForMenu(client, window, previousWindows, "下载");
        if (menu == null) throw new Unavailable("QQ 音乐未公开可识别的下载菜单。");
        Hover(client, menu.Current.BoundingRectangle);

        var quality = WaitForMenu(client, window, previousWindows, QualityLabel);
        if (quality == null) throw new Unavailable("QQ 音乐未公开可识别的 HQ 下载选项。");
        Click(client, quality.Current.BoundingRectangle, false);
    }

    private static AutomationElement WaitForMenu(Process client, IntPtr mainWindow, HashSet<IntPtr> previousWindows, string label)
    {
        var limit = Stopwatch.StartNew();
        while (limit.Elapsed < TimeSpan.FromSeconds(3))
        {
            EnsureForeground(client);
            var roots = new List<AutomationElement>();
            foreach (var window in ClientWindows(client))
            {
                if (window != mainWindow && !previousWindows.Contains(window) && WindowClass(window) == "TXGuiFoundation")
                {
                    try { roots.Add(AutomationElement.FromHandle(window)); }
                    catch (ElementNotAvailableException) { }
                }
            }
            try
            {
                var elements = roots.SelectMany(root => Find(root, Name(label))).Where(element =>
                    element.Current.IsEnabled && Visible(element))
                    .GroupBy(element => string.Join(".", element.GetRuntimeId())).Select(group => group.First()).Take(2).ToArray();
                if (elements.Length == 1) return elements[0];
                if (elements.Length > 1) throw new Unavailable("QQ 音乐菜单存在多个同名选项。");
            }
            catch (ElementNotAvailableException) { }
            Thread.Sleep(ScanInterval);
        }
        return null;
    }

    private static void EnableDpiAwareness()
    {
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
        }
        catch (EntryPointNotFoundException) { }
        SetProcessDPIAware();
    }

    private static void Activate(Process client, IntPtr window)
    {
        if (IsIconic(window))
        {
            ShowWindowAsync(window, 9);
            var limit = Stopwatch.StartNew();
            while (IsIconic(window) && limit.Elapsed < TimeSpan.FromSeconds(1)) Thread.Sleep(80);
            if (IsIconic(window)) throw new Unavailable("QQ 音乐主窗口未能从最小化状态恢复。");
        }
        SetForegroundWindow(window);
        Thread.Sleep(180);
        EnsureForeground(client);
    }

    private static bool IsClientWindow(Process client, IntPtr window)
    {
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        return processId == client.Id;
    }

    private static void EnsureForeground(Process client)
    {
        if (!IsClientWindow(client, GetForegroundWindow()))
            throw new Unavailable("QQ 音乐前台窗口不可用，或用户切换了窗口。");
    }

    private static void Hover(Process client, Rect bounds)
    {
        EnsureForeground(client);
        if (bounds.IsEmpty) throw new Unavailable("QQ 音乐控件已离开可见界面。");
        var point = new ScreenPoint { X = (int)(bounds.Left + bounds.Width / 2), Y = (int)(bounds.Top + bounds.Height / 2) };
        if (!IsClientWindow(client, WindowFromPoint(point)) || !SetCursorPos(point.X, point.Y))
            throw new Unavailable("QQ 音乐控件被其他窗口遮挡。");
    }

    private static void Click(Process client, Rect bounds, bool right)
    {
        Hover(client, bounds);
        EnsureForeground(client);
        SendKeys(Mouse(right ? 0x08u : 0x02u), Mouse(right ? 0x10u : 0x04u));
    }

    private static Input Key(ushort code, uint flags = 0, ushort scan = 0)
    {
        return new Input { Type = 1, Data = new InputValue { Keyboard = new KeyboardInput { Code = code, Flags = flags, Scan = scan } } };
    }

    private static Input Mouse(uint flags)
    {
        return new Input { Type = 0, Data = new InputValue { Mouse = new MouseInput { Flags = flags } } };
    }

    private static void SendKeys(params Input[] input)
    {
        if (SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(Input))) != input.Length)
            throw new Unavailable("Windows 未接收 QQ 音乐的桌面输入。");
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ScreenPoint { internal int X; internal int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect { internal int Left; internal int Top; internal int Right; internal int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowPlacement
    {
        internal int Length;
        internal int Flags;
        internal int ShowCommand;
        internal ScreenPoint MinPosition;
        internal ScreenPoint MaxPosition;
        internal NativeRect NormalPosition;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input { internal uint Type; internal InputValue Data; }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputValue
    {
        [FieldOffset(0)] internal MouseInput Mouse;
        [FieldOffset(0)] internal KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        internal int X;
        internal int Y;
        internal uint Data;
        internal uint Flags;
        internal uint Time;
        internal IntPtr Extra;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        internal ushort Code;
        internal ushort Scan;
        internal uint Flags;
        internal uint Time;
        internal IntPtr Extra;
    }

    private delegate bool WindowCallback(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out NativeRect rectangle);
    [DllImport("user32.dll")] private static extern bool GetWindowPlacement(IntPtr window, ref WindowPlacement placement);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(ScreenPoint point);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
}
