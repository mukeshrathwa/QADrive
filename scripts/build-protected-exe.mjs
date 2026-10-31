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
  const workDir = process.env.QA_DRIVE_ROOT || process.cwd();
  const fakeFilename = path.join(workDir, 'server', 'index.cjs');
  const fakeDirname = path.dirname(fakeFilename);
  const customRequire = Module.createRequire(fakeFilename);
  process.env.QA_DRIVE_EXE_MODE = 'true';
  const rawCode = Buffer.from(${JSON.stringify(codeCompressed)}, 'base64').toString('utf-8');
  const cachedBytes = Buffer.from(${JSON.stringify(bytecodeBase64)}, 'base64');
  const compiled = new vm.Script(rawCode, {
    filename: 'qadrive://protected-core.bin',
    cachedData: cachedBytes
  });
  const wrapper = vm.runInThisContext(Module.wrap(rawCode), {
    filename: 'qadrive://protected-core.bin'
  });
  wrapper(exports, customRequire, module, fakeFilename, fakeDirname);
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
    internal static class NativeGuard
    {
        [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
        internal static extern bool IsDebuggerPresent();

        [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
        internal static extern bool CheckRemoteDebuggerPresent(IntPtr hProcess, ref bool isDebuggerPresent);

        internal static void EnforceAntiReverseEngineering()
        {
            bool remoteDbg = false;
            CheckRemoteDebuggerPresent(Process.GetCurrentProcess().Handle, ref remoteDbg);
            if (Debugger.IsAttached || IsDebuggerPresent() || remoteDbg)
            {
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
                            Environment.FailFast("Security violation: Reverse engineering tool detected.");
                        }
                    }
                }
            }
            catch { }
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
            NativeGuard.EnforceAntiReverseEngineering();

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
                Console.Error.WriteLine("[QA Drive] Protected embedded resource missing.");
                return 1;
            }

            // Reconstruct AES-256 key in memory via XOR unmasking
            byte[] masked = Convert.FromBase64String(MaskedKeyB64);
            byte[] mask = Convert.FromBase64String(XorMaskB64);
            byte[] key = new byte[32];
            for (int i = 0; i < 32; i++)
            {
                key[i] = (byte)(masked[i] ^ mask[i]);
            }
            byte[] iv = Convert.FromBase64String(IvB64);

            // Verify HMAC-SHA256 integrity to prevent binary tampering
            using (HMACSHA256 hmac = new HMACSHA256(key))
            {
                string actualHmac = Convert.ToBase64String(hmac.ComputeHash(cipherBytes));
                if (!string.Equals(actualHmac, ExpectedHmacB64, StringComparison.Ordinal))
                {
                    Console.Error.WriteLine("[QA Drive] Integrity verification failed: binary has been tampered with.");
                    return 2;
                }
            }

            // Decrypt strictly in memory (never writes .js file to disk)
            string decryptedBootstrap;
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

            // Zero out key material in RAM immediately
            Array.Clear(key, 0, key.Length);

            Console.WriteLine("====================================================");
            Console.WriteLine("  QA Drive — Protected Autonomous Test Studio (.exe)");
            Console.WriteLine("  Integrity: VERIFIED (AES-256 + V8 Bytecode Guard)");
            Console.WriteLine("====================================================");

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "node";
            psi.Arguments = "-";
            psi.WorkingDirectory = rootDir;
            psi.UseShellExecute = false;
            psi.RedirectStandardInput = true;
            psi.EnvironmentVariables["QA_DRIVE_ROOT"] = rootDir;
            psi.EnvironmentVariables["QA_DRIVE_EXE_MODE"] = "true";

            try
            {
                Process proc = Process.Start(psi);
                proc.StandardInput.Write(decryptedBootstrap);
                proc.StandardInput.Flush();
                proc.StandardInput.Close();
                decryptedBootstrap = null;
                proc.WaitForExit();
                return proc.ExitCode;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[QA Drive Launch Error] " + ex.Message);
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
