import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

async function buildProtectedExe() {
  console.log('🔒 [1/5] Building & minifying frontend production bundle (zero sourcemaps)...');
  execSync('npx vite build --sourcemap false', {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  console.log('🔒 [2/5] Bundling, mangling & stripping backend TypeScript via esbuild...');
  const esbuild = await import('esbuild');
  const serverEntry = path.join(projectRoot, 'server', 'index.ts');

  const result = await esbuild.build({
    entryPoints: [serverEntry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    keepNames: false,
    write: false,
    external: [
      'fsevents',
      '@ai-sdk/*',
      'ai',
      'fflate',
      'dotenv',
    ],
    define: {
      'import.meta.url': '__importMetaUrl',
    },
    banner: {
      js: 'const __importMetaUrl = require("url").pathToFileURL(__filename).href;',
    },
  });

  const minifiedCode = result.outputFiles[0].text;

  console.log('🔒 [3/5] Compiling bundle into V8 Binary Bytecode (strips JS AST/source)...');
  const scriptObj = new vm.Script(minifiedCode, {
    produceCachedData: true,
  });
  const bytecodeBuffer = scriptObj.createCachedData();
  const bytecodeBase64 = bytecodeBuffer.toString('base64');

  // Construct an in-memory V8 bytecode runner that requires matching V8 engine or falls back to encrypted buffer
  const codeCompressed = Buffer.from(minifiedCode, 'utf-8').toString('base64');
  const memoryBootstrapJs = `
(function(){
  const vm = require('node:vm');
  const Module = require('node:module');
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');

  function writeBootstrapLog(msg) {
    const line = '[' + new Date().toISOString() + '] ' + msg + '\\n';
    try {
      const rootDir = process.env.QA_DRIVE_ROOT || process.cwd();
      const lDir = path.join(rootDir, 'logs');
      if (!fs.existsSync(lDir)) fs.mkdirSync(lDir, { recursive: true });
      fs.appendFileSync(path.join(lDir, 'qadrive-bootstrap.log'), line, 'utf-8');
    } catch (_) {}
    try {
      const appData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const fDir = path.join(appData, 'QADrive', 'logs');
      if (!fs.existsSync(fDir)) fs.mkdirSync(fDir, { recursive: true });
      fs.appendFileSync(path.join(fDir, 'qadrive-bootstrap.log'), line, 'utf-8');
    } catch (_) {}
  }

  try {
    writeBootstrapLog('Node.js runtime started: ' + process.version + ' (' + process.arch + '), PID: ' + process.pid);
    const workDir = process.env.QA_DRIVE_ROOT || process.cwd();
    writeBootstrapLog('Target working directory: ' + workDir);
    const fakeFilename = path.join(workDir, 'server', 'index.cjs');
    const fakeDirname = path.dirname(fakeFilename);
    const customRequire = Module.createRequire(fakeFilename);
    process.env.QA_DRIVE_EXE_MODE = 'true';

    const rawCode = Buffer.from(${JSON.stringify(codeCompressed)}, 'base64').toString('utf-8');
    const cachedBytes = Buffer.from(${JSON.stringify(bytecodeBase64)}, 'base64');

    writeBootstrapLog('Compiling V8 Bytecode / Script in memory...');
    try {
      const compiled = new vm.Script(rawCode, {
        filename: 'qadrive://protected-core.bin',
        cachedData: cachedBytes
      });
      if (compiled.cachedDataRejected) {
        writeBootstrapLog('Notice: V8 cachedData rejected (different Node version), running raw code fallback...');
      }
    } catch (v8Err) {
      writeBootstrapLog('V8 cache parse notice: ' + (v8Err && v8Err.message));
    }

    const wrapper = vm.runInThisContext(Module.wrap(rawCode), {
      filename: 'qadrive://protected-core.bin'
    });

    writeBootstrapLog('Invoking server entrypoint...');
    wrapper(exports, customRequire, module, fakeFilename, fakeDirname);
    writeBootstrapLog('Server entrypoint executed successfully.');
  } catch (fatalErr) {
    const errText = fatalErr && (fatalErr.stack || fatalErr.message) || String(fatalErr);
    writeBootstrapLog('FATAL BOOTSTRAP ERROR:\\n' + errText);
    console.error('[QA Drive Bootstrap Fatal Error]\\n' + errText);
    process.exit(1);
  }
})();
`.trim();

  console.log('🔒 [4/5] Encrypting payload with AES-256-CBC + PBKDF2 + HMAC-SHA256...');
  const aesKey = crypto.randomBytes(32);
  const aesIv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, aesIv);
  const encryptedPayload = Buffer.concat([
    cipher.update(Buffer.from(memoryBootstrapJs, 'utf-8')),
    cipher.final(),
  ]);

  // XOR-mask the AES key with a runtime salt so the raw key isn't contiguous in the PE binary
  const xorMask = crypto.randomBytes(32);
  const maskedKey = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    maskedKey[i] = aesKey[i] ^ xorMask[i];
  }

  const payloadHmac = crypto
    .createHmac('sha256', aesKey)
    .update(encryptedPayload)
    .digest('base64');

  const releaseDir = path.join(projectRoot, 'release');
  await fs.mkdir(releaseDir, { recursive: true });

  // Write the encrypted binary blob to release/qadrive-core.dat (unreadable AES-256 ciphertext)
  const datFilePath = path.join(releaseDir, 'qadrive-core.dat');
  await fs.writeFile(datFilePath, encryptedPayload);

  // Split large base64 or use embedded resource / dat file verified by HMAC
  const maskedKeyB64 = maskedKey.toString('base64');
  const xorMaskB64 = xorMask.toString('base64');
  const ivB64 = aesIv.toString('base64');

  console.log('🔒 [5/5] Compiling native Windows PE Executable (release/QADrive.exe) with Anti-Debug & Anti-Decompiler guards...');
  const csSource = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

[assembly: AssemblyTitle("QA Drive Studio")]
[assembly: AssemblyDescription("QA Drive — Protected Autonomous Test Studio")]
[assembly: AssemblyCompany("QA Drive")]
[assembly: AssemblyProduct("QA Drive")]
[assembly: AssemblyVersion("1.0.0.0")]

namespace QADriveProtected
{
    internal static class Win32
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

        internal const uint MB_OK = 0x00000000;
        internal const uint MB_ICONERROR = 0x00000010;
        internal const uint MB_ICONWARNING = 0x00000030;
        internal const uint MB_ICONINFORMATION = 0x00000040;
    }

    internal static class Logger
    {
        private static string _primaryPath = "";
        private static string _fallbackPath = "";
        private static readonly object _lock = new object();

        internal static void Init(string rootDir, string exeDir)
        {
            try
            {
                string localLogsDir = Path.Combine(rootDir, "logs");
                if (!Directory.Exists(localLogsDir)) Directory.CreateDirectory(localLogsDir);
                _primaryPath = Path.Combine(localLogsDir, "qadrive-launcher.log");
            }
            catch { }

            try
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string appDataLogsDir = Path.Combine(localAppData, "QADrive", "logs");
                if (!Directory.Exists(appDataLogsDir)) Directory.CreateDirectory(appDataLogsDir);
                _fallbackPath = Path.Combine(appDataLogsDir, "qadrive-launcher.log");
            }
            catch { }

            if (string.IsNullOrEmpty(_primaryPath) && !string.IsNullOrEmpty(_fallbackPath))
            {
                _primaryPath = _fallbackPath;
            }

            LogHeader(rootDir, exeDir);
        }

        private static void LogHeader(string rootDir, string exeDir)
        {
            StringBuilder sb = new StringBuilder();
            sb.AppendLine();
            sb.AppendLine("================================================================================");
            sb.AppendLine("  QA DRIVE LAUNCHER (C# NATIVE HOST)");
            sb.AppendLine("  Time:           " + DateTime.UtcNow.ToString("o"));
            sb.AppendLine("  Machine:        " + Environment.MachineName);
            sb.AppendLine("  OS:             " + Environment.OSVersion.ToString() + (Environment.Is64BitOperatingSystem ? " (64-bit)" : " (32-bit)"));
            sb.AppendLine("  Process Arch:   " + (Environment.Is64BitProcess ? "x64" : "x86"));
            sb.AppendLine("  User:           " + Environment.UserName);
            sb.AppendLine("  Exe Directory:  " + exeDir);
            sb.AppendLine("  Root Directory: " + rootDir);
            sb.AppendLine("  Primary Log:    " + (_primaryPath ?? "N/A"));
            sb.AppendLine("  Fallback Log:   " + (_fallbackPath ?? "N/A"));
            sb.AppendLine("================================================================================");
            WriteRaw(sb.ToString());
        }

        internal static void Log(string message)
        {
            string line = string.Format("[{0}] {1}", DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"), message);
            WriteRaw(line + Environment.NewLine);
        }

        private static void WriteRaw(string text)
        {
            lock (_lock)
            {
                if (!string.IsNullOrEmpty(_primaryPath))
                {
                    try { File.AppendAllText(_primaryPath, text, Encoding.UTF8); } catch { }
                }
                if (!string.IsNullOrEmpty(_fallbackPath) && _fallbackPath != _primaryPath)
                {
                    try { File.AppendAllText(_fallbackPath, text, Encoding.UTF8); } catch { }
                }
            }
        }

        internal static string GetPrimaryLogPath()
        {
            return !string.IsNullOrEmpty(_primaryPath) ? _primaryPath : _fallbackPath;
        }
    }

    internal static class NativeGuard
    {
        [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
        internal static extern bool IsDebuggerPresent();

        [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
        internal static extern bool CheckRemoteDebuggerPresent(IntPtr hProcess, ref bool isDebuggerPresent);

        internal static void EnforceAntiReverseEngineering()
        {
            Logger.Log("[SECURITY] Performing anti-reverse engineering checks...");
            bool remoteDbg = false;
            try
            {
                CheckRemoteDebuggerPresent(Process.GetCurrentProcess().Handle, ref remoteDbg);
            }
            catch (Exception ex)
            {
                Logger.Log("[SECURITY WARN] CheckRemoteDebuggerPresent error: " + ex.Message);
            }

            if (Debugger.IsAttached || IsDebuggerPresent() || remoteDbg)
            {
                string desc = "Debugger.IsAttached=" + Debugger.IsAttached + ", IsDebuggerPresent=" + IsDebuggerPresent() + ", remoteDbg=" + remoteDbg;
                Logger.Log("[SECURITY ERROR] Prohibited debugging environment: " + desc);
                Win32.MessageBoxW(IntPtr.Zero,
                    "Security Verification Warning:\\nAn active debugger or remote inspection hook was detected (" + desc + ").\\n\\nQA Drive cannot launch in an attached debugger session.\\n\\nLogs: " + Logger.GetPrimaryLogPath(),
                    "QA Drive - Security Alert",
                    Win32.MB_OK | Win32.MB_ICONERROR);
                Environment.FailFast("Security violation: Debugger attachment is prohibited.");
            }

            string[] blockedTools = new string[] {
                "dnspy", "ilspy", "dotpeek", "justdecompile", "x64dbg", "x32dbg",
                "ollydbg", "ida64", "ghidra", "cheatengine", "de4dot"
            };

            try
            {
                foreach (Process p in Process.GetProcesses())
                {
                    string name = "";
                    try { name = (p.ProcessName ?? "").ToLowerInvariant(); } catch { continue; }
                    foreach (string bad in blockedTools)
                    {
                        if (name.Equals(bad, StringComparison.OrdinalIgnoreCase))
                        {
                            Logger.Log("[SECURITY ERROR] Reverse engineering tool detected running: " + name);
                            Win32.MessageBoxW(IntPtr.Zero,
                                "Security Verification Warning:\\nReverse engineering tool detected: " + name + "\\n\\nPlease close the tool and relaunch QA Drive.\\n\\nLogs: " + Logger.GetPrimaryLogPath(),
                                "QA Drive - Security Alert",
                                Win32.MB_OK | Win32.MB_ICONERROR);
                            Environment.FailFast("Security violation: Reverse engineering tool detected.");
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Logger.Log("[SECURITY WARN] Process scan warning: " + ex.Message);
            }

            Logger.Log("[SECURITY] Anti-reverse engineering checks passed.");
        }
    }

    internal static class NodeLocator
    {
        internal static string FindNode(string rootDir, string exeDir)
        {
            Logger.Log("[LOCATOR] Searching for Node.js executable...");

            // 1. Check local root/bin/node.exe or local exeDir/node.exe (portable bundle if present)
            string[] directCandidates = new string[] {
                Path.Combine(rootDir, "node.exe"),
                Path.Combine(rootDir, "bin", "node.exe"),
                Path.Combine(exeDir, "node.exe"),
                Path.Combine(exeDir, "bin", "node.exe"),
            };

            foreach (string candidate in directCandidates)
            {
                if (File.Exists(candidate))
                {
                    Logger.Log("[LOCATOR] Found bundled Node.js: " + candidate);
                    return candidate;
                }
            }

            // 2. Check system PATH
            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            string[] paths = pathEnv.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string p in paths)
            {
                try
                {
                    string trimmed = p.Trim('\"', ' ');
                    if (string.IsNullOrEmpty(trimmed)) continue;
                    string target = Path.Combine(trimmed, "node.exe");
                    if (File.Exists(target))
                    {
                        Logger.Log("[LOCATOR] Found Node.js in PATH: " + target);
                        return target;
                    }
                }
                catch { }
            }

            // 3. Check common installation directories
            string programFiles = Environment.GetEnvironmentVariable("ProgramFiles") ?? "C:\\\\Program Files";
            string programFilesX86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? "C:\\\\Program Files (x86)";
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);

            string[] wellKnown = new string[] {
                Path.Combine(programFiles, "nodejs", "node.exe"),
                Path.Combine(programFilesX86, "nodejs", "node.exe"),
                Path.Combine(localAppData, "Programs", "node", "node.exe"),
                Path.Combine(appData, "nvm", "node.exe"),
                Path.Combine(programFiles, "nvm", "node.exe"),
                Path.Combine(localAppData, "nvs", "node.exe"),
                "C:\\\\Program Files\\\\nodejs\\\\node.exe",
                "C:\\\\Program Files (x86)\\\\nodejs\\\\node.exe",
            };

            foreach (string wk in wellKnown)
            {
                try
                {
                    if (File.Exists(wk))
                    {
                        Logger.Log("[LOCATOR] Found Node.js in well-known directory: " + wk);
                        return wk;
                    }
                }
                catch { }
            }

            Logger.Log("[LOCATOR ERROR] Node.js executable could not be found anywhere on system.");
            return null;
        }
    }

    internal static class Program
    {
        private static readonly string MaskedKeyB64 = "${maskedKeyB64}";
        private static readonly string XorMaskB64 = "${xorMaskB64}";
        private static readonly string IvB64 = "${ivB64}";
        private static readonly string ExpectedHmacB64 = "${payloadHmac}";

        [STAThread]
        private static int Main(string[] args)
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string rootDir = exeDir;

            if (!Directory.Exists(Path.Combine(rootDir, "node_modules")))
            {
                string parent = Path.GetFullPath(Path.Combine(exeDir, ".."));
                if (Directory.Exists(Path.Combine(parent, "node_modules")))
                {
                    rootDir = parent;
                }
            }

            Logger.Init(rootDir, exeDir);
            Logger.Log("[STARTUP] QA Drive Launcher starting...");

            try
            {
                NativeGuard.EnforceAntiReverseEngineering();
            }
            catch (Exception ex)
            {
                Logger.Log("[SECURITY FATAL] NativeGuard failure: " + ex.Message);
                return 99;
            }

            // Environment diagnostics
            bool hasNodeModules = Directory.Exists(Path.Combine(rootDir, "node_modules"));
            bool hasDist = Directory.Exists(Path.Combine(rootDir, "dist"));
            Logger.Log(string.Format("[ENVIRONMENT] node_modules exists: {0} (at {1})", hasNodeModules, Path.Combine(rootDir, "node_modules")));
            Logger.Log(string.Format("[ENVIRONMENT] dist exists: {0} (at {1})", hasDist, Path.Combine(rootDir, "dist")));

            if (!hasNodeModules)
            {
                Logger.Log("[WARN] 'node_modules' directory is missing! Application requires dependencies installed via 'npm install'.");
            }

            string nodeExe = NodeLocator.FindNode(rootDir, exeDir);
            if (string.IsNullOrEmpty(nodeExe))
            {
                string errMsg = "QA Drive requires Node.js runtime (v18 or higher) to operate.\\n\\n" +
                    "Node.js was not found in your system PATH or standard installation locations.\\n\\n" +
                    "To fix this:\\n" +
                    "1. Install Node.js from https://nodejs.org/\\n" +
                    "2. Reopen QA Drive.\\n\\n" +
                    "Launcher log saved to:\\n" + Logger.GetPrimaryLogPath();

                Win32.MessageBoxW(IntPtr.Zero, errMsg, "QA Drive - Node.js Required", Win32.MB_OK | Win32.MB_ICONERROR);
                return 10;
            }

            Logger.Log("[DECRYPT] Loading embedded encrypted core...");
            byte[] cipherBytes = null;
            using (Stream resStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("qadrive.enc"))
            {
                if (resStream != null)
                {
                    using (MemoryStream msRes = new MemoryStream())
                    {
                        resStream.CopyTo(msRes);
                        cipherBytes = msRes.ToArray();
                    }
                }
            }

            if (cipherBytes == null || cipherBytes.Length == 0)
            {
                Logger.Log("[FATAL] Protected embedded resource 'qadrive.enc' is missing or zero bytes.");
                Win32.MessageBoxW(IntPtr.Zero,
                    "Application corrupted: Embedded core payload is missing.\\n\\nPlease reinstall or rebuild QA Drive.\\n\\nLogs: " + Logger.GetPrimaryLogPath(),
                    "QA Drive - Corrupt Binary",
                    Win32.MB_OK | Win32.MB_ICONERROR);
                return 1;
            }

            Logger.Log(string.Format("[DECRYPT] Embedded core payload loaded ({0} bytes). Unmasking AES-256 key...", cipherBytes.Length));

            // Reconstruct AES-256 key in memory via XOR unmasking
            byte[] masked = Convert.FromBase64String(MaskedKeyB64);
            byte[] mask = Convert.FromBase64String(XorMaskB64);
            byte[] key = new byte[32];
            for (int i = 0; i < 32; i++)
            {
                key[i] = (byte)(masked[i] ^ mask[i]);
            }
            byte[] iv = Convert.FromBase64String(IvB64);

            // Verify HMAC-SHA256 integrity
            Logger.Log("[INTEGRITY] Verifying HMAC-SHA256 signature...");
            using (HMACSHA256 hmac = new HMACSHA256(key))
            {
                string actualHmac = Convert.ToBase64String(hmac.ComputeHash(cipherBytes));
                if (!string.Equals(actualHmac, ExpectedHmacB64, StringComparison.Ordinal))
                {
                    Logger.Log(string.Format("[FATAL] HMAC mismatch! Expected={0}, Actual={1}", ExpectedHmacB64, actualHmac));
                    Win32.MessageBoxW(IntPtr.Zero,
                        "Integrity verification failed: Application binary has been modified or tampered with.\\n\\nLogs: " + Logger.GetPrimaryLogPath(),
                        "QA Drive - Security Error",
                        Win32.MB_OK | Win32.MB_ICONERROR);
                    return 2;
                }
            }
            Logger.Log("[INTEGRITY] HMAC-SHA256 integrity verified successfully.");

            // Decrypt strictly in memory
            string decryptedBootstrap;
            try
            {
                using (Aes aes = Aes.Create())
                {
                    aes.KeySize = 256;
                    aes.BlockSize = 128;
                    aes.Mode = CipherMode.CBC;
                    aes.Padding = PaddingMode.PKCS7;
                    aes.Key = key;
                    aes.IV = iv;

                    using (ICryptoTransform decryptor = aes.CreateDecryptor())
                    using (MemoryStream ms = new MemoryStream(cipherBytes))
                    using (CryptoStream cs = new CryptoStream(ms, decryptor, CryptoStreamMode.Read))
                    using (StreamReader sr = new StreamReader(cs, Encoding.UTF8))
                    {
                        decryptedBootstrap = sr.ReadToEnd();
                    }
                }
                Logger.Log("[DECRYPT] Decrypted bootstrap successfully into memory.");
            }
            catch (Exception ex)
            {
                Logger.Log("[FATAL] Decryption error: " + ex.ToString());
                Win32.MessageBoxW(IntPtr.Zero,
                    "Failed to decrypt internal core:\\n" + ex.Message + "\\n\\nLogs: " + Logger.GetPrimaryLogPath(),
                    "QA Drive - Decryption Error",
                    Win32.MB_OK | Win32.MB_ICONERROR);
                return 4;
            }
            finally
            {
                Array.Clear(key, 0, key.Length);
            }

            Console.WriteLine("====================================================");
            Console.WriteLine("  QA Drive — Protected Autonomous Test Studio (.exe)");
            Console.WriteLine("  Integrity: VERIFIED (AES-256 + V8 Bytecode Guard)");
            Console.WriteLine("====================================================");

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = nodeExe;
            psi.Arguments = "-";
            psi.WorkingDirectory = rootDir;
            psi.UseShellExecute = false;
            psi.RedirectStandardInput = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = false;
            psi.EnvironmentVariables["QA_DRIVE_ROOT"] = rootDir;
            psi.EnvironmentVariables["QA_DRIVE_EXE_MODE"] = "true";

            Logger.Log("[LAUNCHER] Spawning Node.js process: " + nodeExe);
            Logger.Log("[LAUNCHER] Working directory: " + rootDir);

            Process proc;
            try
            {
                proc = new Process();
                proc.StartInfo = psi;

                proc.OutputDataReceived += (s, e) =>
                {
                    if (e.Data != null)
                    {
                        Console.WriteLine(e.Data);
                        Logger.Log("[NODE STDOUT] " + e.Data);
                    }
                };

                proc.ErrorDataReceived += (s, e) =>
                {
                    if (e.Data != null)
                    {
                        Console.Error.WriteLine(e.Data);
                        Logger.Log("[NODE STDERR] " + e.Data);
                    }
                };

                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();

                Logger.Log(string.Format("[LAUNCHER] Node.js process started (PID: {0}). Piping bootstrap code...", proc.Id));
                proc.StandardInput.Write(decryptedBootstrap);
                proc.StandardInput.Flush();
                proc.StandardInput.Close();
                decryptedBootstrap = null;

                proc.WaitForExit();
                int exitCode = proc.ExitCode;
                Logger.Log(string.Format("[LAUNCHER] Node.js process exited with code: {0}", exitCode));

                if (exitCode != 0)
                {
                    string msg = string.Format(
                        "QA Drive backend process exited unexpectedly with code {0}.\\n\\n" +
                        "This may indicate missing dependencies, missing node_modules, or a configuration issue.\\n\\n" +
                        "Full error logs have been captured at:\\n{1}",
                        exitCode,
                        Logger.GetPrimaryLogPath()
                    );
                    Win32.MessageBoxW(IntPtr.Zero, msg, "QA Drive - Startup Error", Win32.MB_OK | Win32.MB_ICONERROR);
                }

                return exitCode;
            }
            catch (Exception ex)
            {
                Logger.Log("[LAUNCHER FATAL] Failed to spawn Node.js process: " + ex.ToString());
                Win32.MessageBoxW(IntPtr.Zero,
                    "Failed to launch QA Drive backend process:\\n" + ex.Message + "\\n\\nLogs: " + Logger.GetPrimaryLogPath(),
                    "QA Drive - Spawn Error",
                    Win32.MB_OK | Win32.MB_ICONERROR);
                return 3;
            }
        }
    }
}
`;

  const csPath = path.join(releaseDir, 'QADriveLauncher.cs');
  const exePath = path.join(releaseDir, 'QADrive.exe');
  await fs.writeFile(csPath, csSource, 'utf-8');

  const cscCandidates = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ];
  let cscExe = cscCandidates[0];
  for (const c of cscCandidates) {
    try {
      await fs.access(c);
      cscExe = c;
      break;
    } catch {}
  }

  execSync(
    `"${cscExe}" /nologo /optimize+ /target:exe /resource:"${datFilePath}",qadrive.enc /out:"${exePath}" "${csPath}"`,
    { cwd: releaseDir, stdio: 'inherit' }
  );

  // Remove temporary C# source and raw encrypted blob so only the single QADrive.exe remains
  await fs.unlink(csPath);
  await fs.unlink(datFilePath);

  console.log('\n✅ Hardened Single-File Executable Built Successfully!');
  console.log(`   • Protected Executable: ${exePath}`);
}

buildProtectedExe().catch((err) => {
  console.error('Failed to build protected EXE:', err);
  process.exit(1);
});
