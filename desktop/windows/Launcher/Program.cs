using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program
{
    private static readonly string Root = AppContext.BaseDirectory;
    private static readonly string Resources = Path.Combine(Root, "resources");
    private static readonly string Base = Path.Combine(Resources, "dsh-workbench-fix", "dsh-base");
    private static readonly string Node = Path.Combine(Resources, "runtime", "node", "node.exe");
    private static readonly string Cli = Path.Combine(Base, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    private static readonly string Data = Environment.GetEnvironmentVariable("JIANGJIE_DESKTOP_DATA")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "讲界");

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.FirstOrDefault() == "--desktop-settings-keychain")
            {
                CredentialCommand();
                return 0;
            }
            if (string.Equals(Path.GetFileName(Environment.ProcessPath), "dsh.exe", StringComparison.OrdinalIgnoreCase))
                return RunCli(args);
            ApplicationConfiguration.Initialize();
            using var lockFile = OpenLock();
            using var workbench = new Workbench();
            if (args.FirstOrDefault() == "--integration-test")
                return workbench.IntegrationTestAsync().GetAwaiter().GetResult();
            using var window = new DesktopForm(workbench, args.FirstOrDefault() == "--smoke");
            Application.Run(window);
            return window.ExitCode;
        }
        catch (Exception error)
        {
            if (args.FirstOrDefault() is "--smoke" or "--integration-test" or "--desktop-settings-keychain")
                Console.Error.WriteLine(error.Message);
            else
                MessageBox.Show(error.Message, "讲界启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static FileStream OpenLock()
    {
        Directory.CreateDirectory(Data);
        return new FileStream(Path.Combine(Data, "desktop.lock"), FileMode.OpenOrCreate,
            FileAccess.ReadWrite, FileShare.None);
    }

    private static void CredentialCommand()
    {
        using JsonDocument input = JsonDocument.Parse(Console.In.ReadToEnd());
        string action = input.RootElement.GetProperty("action").GetString() ?? throw new InvalidDataException("缺少操作");
        string scope = input.RootElement.GetProperty("scope").GetString() ?? throw new InvalidDataException("缺少范围");
        if (scope.Length != 64 || scope.Any(c => !Uri.IsHexDigit(c)))
            throw new InvalidDataException("密钥范围无效");
        string directory = Path.Combine(Data, "credentials");
        string file = Path.Combine(directory, scope + ".bin");
        if (action == "read")
        {
            byte[] encrypted = File.ReadAllBytes(file);
            Console.Out.Write(Encoding.UTF8.GetString(ProtectedData.Unprotect(encrypted, null, DataProtectionScope.CurrentUser)));
        }
        else if (action == "write")
        {
            JsonElement keys = input.RootElement.GetProperty("keys");
            if (keys.ValueKind != JsonValueKind.Object) throw new InvalidDataException("密钥格式无效");
            if (!keys.EnumerateObject().Any()) { File.Delete(file); return; }
            Directory.CreateDirectory(directory);
            byte[] encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(keys.GetRawText()), null, DataProtectionScope.CurrentUser);
            string temp = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".tmp");
            File.WriteAllBytes(temp, encrypted);
            File.Move(temp, file, true);
        }
        else throw new InvalidDataException("未知密钥操作");
    }

    private static int RunCli(string[] args)
    {
        var start = new ProcessStartInfo(Node) { UseShellExecute = false, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        start.ArgumentList.Add(Cli);
        foreach (string arg in args) start.ArgumentList.Add(arg);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("无法启动 DSH");
        Task input = Task.Run(async () => { await Console.OpenStandardInput().CopyToAsync(process.StandardInput.BaseStream); process.StandardInput.Close(); });
        Task output = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
        Task error = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
        process.WaitForExit();
        Task.WaitAll(output, error);
        return process.ExitCode;
    }

    internal sealed class Workbench : IDisposable
    {
        private readonly Process process;
        private readonly TaskCompletionSource<Uri> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private string lastLine = "";

        public Workbench()
        {
            string dshHome = Path.Combine(Data, "dsh");
            string profile = Path.Combine(dshHome, "profiles", "workbench");
            string workspace = Path.Combine(Data, "workspace");
            Directory.CreateDirectory(profile);
            Directory.CreateDirectory(workspace);
            foreach (string name in new[] { "package.json", "cordis.yml", "cordis.patch.yml" })
            {
                string destination = Path.Combine(profile, name);
                if (!File.Exists(destination))
                    File.Copy(Path.Combine(Base, ".dsh-home", "profiles", "workbench", name), destination);
            }
            foreach (string name in new[] { ".agents", "rules" })
            {
                string destination = Path.Combine(workspace, name);
                if (!Directory.Exists(destination))
                    CopyDirectory(Path.Combine(Base, "workspace", name), destination);
            }
            string plugin = Path.Combine(profile, "node_modules", "@bohack", "blueprint");
            Directory.CreateDirectory(Path.GetDirectoryName(plugin)!);
            if (Directory.Exists(plugin))
            {
                var info = new DirectoryInfo(plugin);
                if ((info.Attributes & FileAttributes.ReparsePoint) == 0)
                    throw new IOException("工作台插件目录已存在且不是链接：" + plugin);
                Directory.Delete(plugin);
            }
            CreateJunction(plugin, Path.Combine(Base, "packages", "bohack-blueprint"));

            string kit = Path.Combine(Resources, "video-kit");
            string python = Path.Combine(Resources, "runtime", "python", "python.exe");
            string ffmpeg = Path.Combine(Resources, "runtime", "ffmpeg");
            var start = new ProcessStartInfo(Node) { WorkingDirectory = Base, UseShellExecute = false,
                RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
            foreach (string arg in new[] { Cli, "--profile", "workbench", "--patch",
                Path.Combine(Resources, "desktop-agent.patch.yml"), "--port", "0", "--host", "127.0.0.1", "--no-open" })
                start.ArgumentList.Add(arg);
            start.Environment.Remove("NODE_PATH");
            start.Environment.Remove("NODE_OPTIONS");
            start.Environment.Remove("PYTHONHOME");
            start.Environment.Remove("PYTHONPATH");
            start.Environment["PATH"] = string.Join(Path.PathSeparator, Path.GetDirectoryName(Node), Path.GetDirectoryName(python),
                ffmpeg, Environment.GetEnvironmentVariable("PATH"));
            start.Environment["DSH_HOME"] = dshHome;
            start.Environment["DSH_CLI"] = Path.Combine(Root, "dsh.exe");
            start.Environment["PYTHONNOUSERSITE"] = "1";
            start.Environment["PYTHONDONTWRITEBYTECODE"] = "1";
            start.Environment["VIDEO_KIT_DIR"] = kit;
            start.Environment["VIDEO_FFMPEG"] = Path.Combine(ffmpeg, "ffmpeg.exe");
            start.Environment["VIDEO_FFPROBE"] = Path.Combine(ffmpeg, "ffprobe.exe");
            start.Environment["VIDEO_PYTHON"] = python;
            start.Environment["VIDEO_BROWSER"] = Path.Combine(Resources, "runtime", "browser", "chrome.exe");
            start.Environment["VIDEO_PLAYWRIGHT"] = Path.Combine(kit, "node_modules", "playwright-core", "index.js");
            start.Environment["JIANGJIE_DESKTOP_WORKSPACE"] = workspace;
            start.Environment["BOHACK_DESKTOP_KEYCHAIN_HELPER"] = Environment.ProcessPath!;
            start.Environment["JIANGJIE_MEMBER_URL"] = Environment.GetEnvironmentVariable("JIANGJIE_MEMBER_URL")
                ?? "https://jiangjie.gingers.cloud/desktop-membership";
            start.Environment["JIANGJIE_DESKTOP_AGENT_MARKER"] = "local-desktop-route";
            start.Environment["JIANGJIE_DESKTOP_DSH_PATCH"] = Path.Combine(Resources, "desktop-agent.patch.yml");

            process = new Process { StartInfo = start, EnableRaisingEvents = true };
            process.OutputDataReceived += OnOutput;
            process.ErrorDataReceived += OnOutput;
            process.Exited += (_, _) => ready.TrySetException(new InvalidOperationException("本机工作台已退出。" + lastLine));
            if (!process.Start()) throw new InvalidOperationException("无法启动本机工作台");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }

        private static void CopyDirectory(string source, string destination)
        {
            Directory.CreateDirectory(destination);
            foreach (string file in Directory.GetFiles(source)) File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
            foreach (string subdir in Directory.GetDirectories(source)) CopyDirectory(subdir, Path.Combine(destination, Path.GetFileName(subdir)));
        }

        private static void CreateJunction(string link, string target)
        {
            var start = new ProcessStartInfo("cmd.exe", $"/d /c mklink /J \"{link}\" \"{target}\"") {
                UseShellExecute = false, RedirectStandardError = true, RedirectStandardOutput = true, CreateNoWindow = true };
            using var command = Process.Start(start) ?? throw new InvalidOperationException("无法创建工作台目录链接");
            string output = command.StandardOutput.ReadToEnd() + command.StandardError.ReadToEnd();
            command.WaitForExit();
            if (command.ExitCode != 0) throw new IOException("创建工作台目录链接失败：" + output);
        }

        private void OnOutput(object sender, DataReceivedEventArgs e)
        {
            string? line = e.Data;
            if (line == null) return;
            if (!line.Contains("token=", StringComparison.OrdinalIgnoreCase)) lastLine = line;
            const string prefix = "dsh web: ";
            if (line.StartsWith(prefix, StringComparison.Ordinal) &&
                Uri.TryCreate(line[prefix.Length..].Trim(), UriKind.Absolute, out Uri? uri) &&
                uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.Port > 0)
                ready.TrySetResult(new Uri(uri, "/bohack/"));
        }

        public async Task<Uri> ReadyAsync()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            try { return await ready.Task.WaitAsync(timeout.Token); }
            catch (OperationCanceledException) { throw new TimeoutException("等待工作台启动超时。" + lastLine); }
        }

        public async Task<int> IntegrationTestAsync()
        {
            Uri uri = await ReadyAsync();
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
            string html = await client.GetStringAsync(uri);
            if (!html.Contains("讲界", StringComparison.Ordinal)) throw new InvalidDataException("工作台页面内容不完整");
            Console.Out.WriteLine($"dsh web: {uri.GetLeftPart(UriPartial.Authority)}");
            Console.Out.Flush();
            await Console.In.ReadToEndAsync();
            return 0;
        }

        public void Dispose()
        {
            if (!process.HasExited) { process.Kill(entireProcessTree: true); process.WaitForExit(); }
            process.Dispose();
        }
    }

    private sealed class DesktopForm : Form
    {
        private readonly Workbench workbench;
        private readonly bool smoke;
        private readonly WebView2 web = new() { Dock = DockStyle.Fill };
        private Uri? workbenchUrl;
        public int ExitCode { get; private set; }

        public DesktopForm(Workbench workbench, bool smoke)
        {
            this.workbench = workbench;
            this.smoke = smoke;
            Text = "讲界视频工坊";
            Width = 1200;
            Height = 780;
            MinimumSize = new Size(720, 480);
            StartPosition = FormStartPosition.CenterScreen;
            Controls.Add(web);
            Shown += async (_, _) => await StartAsync();
        }

        private async Task StartAsync()
        {
            try
            {
                workbenchUrl = await workbench.ReadyAsync();
                var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: Path.Combine(Data, "webview"));
                await web.EnsureCoreWebView2Async(environment);
                web.CoreWebView2.NavigationStarting += (_, e) =>
                {
                    if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out Uri? destination)) { e.Cancel = true; return; }
                    if (destination.Scheme == workbenchUrl.Scheme && destination.Host == workbenchUrl.Host &&
                        destination.Port == workbenchUrl.Port) return;
                    e.Cancel = true;
                    if (destination.Scheme is "https" or "http") Process.Start(new ProcessStartInfo(destination.AbsoluteUri) { UseShellExecute = true });
                };
                web.CoreWebView2.NewWindowRequested += (_, e) =>
                {
                    e.Handled = true;
                    if (Uri.TryCreate(e.Uri, UriKind.Absolute, out Uri? destination) && destination.Scheme is "https" or "http")
                        Process.Start(new ProcessStartInfo(destination.AbsoluteUri) { UseShellExecute = true });
                };
                if (smoke) web.CoreWebView2.NavigationCompleted += CompleteSmokeAsync;
                web.CoreWebView2.Navigate(workbenchUrl.AbsoluteUri);
            }
            catch (Exception error)
            {
                CloseWithError(error.Message);
            }
        }

        private async void CompleteSmokeAsync(object? sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            try
            {
                if (!e.IsSuccess) throw new InvalidOperationException($"工作台加载失败：{e.WebErrorStatus}");
                if (await web.ExecuteScriptAsync("document.getElementById('accountBtn') !== null") != "true")
                    throw new InvalidDataException("桌面窗口未显示会员入口");
                Close();
            }
            catch (Exception error) { CloseWithError(error.Message); }
        }

        private void CloseWithError(string message)
        {
            ExitCode = 1;
            if (smoke) Console.Error.WriteLine(message);
            else MessageBox.Show(message, "讲界启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }
}
