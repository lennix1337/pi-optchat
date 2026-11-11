/**
 * The Windows sampler helper: one long-lived console program (.NET Framework's own csc.exe builds it, once, into the
 * data folder) that prints one JSON line per sample on stdout and exits when its stdin closes. A PowerShell or CIM call
 * per sample costs about a second of CPU each time; this one loop costs a few milliseconds.
 *
 * Line: {"t":unixMs,"cpu":percent|null,"mem":[usedMb,totalMb],"idle":seconds,"pid":helperPid,"p":[[pid,ppid,startMs,"name",cpuMs,workingSetKb,priorityClass,"cmd"?],...]}
 * `cmd` rides only on the first sample of a process inside the tree that starts at the root pid given as argument 1 (the
 * command line, cut to 200 characters; never the environment). Arguments: rootPid intervalMs.
 * C# 5 only: that is what the csc.exe shipped with Windows compiles.
 */
export const HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Sampler
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32 { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
    [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint lo, hi; }
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize, dwTime; }
    [StructLayout(LayoutKind.Sequential)] struct MEMORYSTATUSEX { public uint dwLength, dwMemoryLoad; public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual; }
    [StructLayout(LayoutKind.Sequential)] struct PMC { public uint cb, PageFaultCount; public UIntPtr PeakWorkingSetSize, WorkingSetSize, a, b, c, d, PagefileUsage, PeakPagefileUsage; }
    [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr Reserved1, PebBaseAddress, Reserved2a, Reserved2b, UniqueProcessId, Reserved3; }

    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr h, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr h, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out FILETIME c, out FILETIME e, out FILETIME k, out FILETIME u);
    [DllImport("kernel32.dll")] static extern uint GetPriorityClass(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool GetSystemTimes(out FILETIME idle, out FILETIME kernel, out FILETIME user);
    [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX m);
    [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow);
    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
    [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr h, out PMC c, uint size);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI info, int len, out int ret);

    const uint LIMITED = 0x1000, VMREAD = 0x0010, QUERY = 0x0400;
    static long Ticks(FILETIME f) { return ((long)f.hi << 32) | f.lo; }
    // FILETIME (100 ns since 1601) to Unix milliseconds.
    static long UnixMs(FILETIME f) { long t = Ticks(f); return t == 0 ? 0 : t / 10000 - 11644473600000L; }

    class Known { public long start; public long seen; }
    static Dictionary<uint, Known> tree = new Dictionary<uint, Known>();

    static string CommandLine(uint pid)
    {
        IntPtr h = OpenProcess(QUERY | VMREAD, false, pid);
        if (h == IntPtr.Zero) return null;
        try
        {
            bool wow; if (!IsWow64Process(h, out wow) || wow) return null;
            PBI pbi = new PBI(); int ret;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PBI)), out ret) != 0 || pbi.PebBaseAddress == IntPtr.Zero) return null;
            IntPtr read; byte[] p = new byte[8];
            if (!ReadProcessMemory(h, new IntPtr(pbi.PebBaseAddress.ToInt64() + 0x20), p, new IntPtr(8), out read)) return null;
            long parameters = BitConverter.ToInt64(p, 0);
            byte[] us = new byte[16];
            if (!ReadProcessMemory(h, new IntPtr(parameters + 0x70), us, new IntPtr(16), out read)) return null;
            int length = BitConverter.ToUInt16(us, 0); long buffer = BitConverter.ToInt64(us, 8);
            if (length <= 0 || buffer == 0) return null;
            if (length > 800) length = 800;
            byte[] text = new byte[length];
            if (!ReadProcessMemory(h, new IntPtr(buffer), text, new IntPtr(length), out read)) return null;
            return Encoding.Unicode.GetString(text, 0, length);
        }
        catch (Exception) { return null; }
        finally { CloseHandle(h); }
    }

    static void Escape(StringBuilder sb, string s)
    {
        sb.Append('"');
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') { sb.Append('\\').Append(c); }
            else if (c < 32) { sb.Append(' '); }
            else sb.Append(c);
        }
        sb.Append('"');
    }

    class Proc { public uint pid, ppid; public long start; public string name; public long cpuMs; public long wsKb; public uint prio; public string cmd; }

    static int Main(string[] args)
    {
        uint root = args.Length > 0 ? uint.Parse(args[0]) : 0;
        int interval = args.Length > 1 ? int.Parse(args[1]) : 5000;
        new Thread(delegate () { try { while (Console.In.Read() >= 0) { } } catch (Exception) { } Environment.Exit(0); }) { IsBackground = true }.Start();
        Console.OutputEncoding = new UTF8Encoding(false);
        FILETIME i0, k0, u0; GetSystemTimes(out i0, out k0, out u0);
        long lastIdle = Ticks(i0), lastTotal = Ticks(k0) + Ticks(u0);
        bool first = true;
        Stopwatch pace = Stopwatch.StartNew();
        while (true)
        {
            List<Proc> procs = new List<Proc>();
            IntPtr snap = CreateToolhelp32Snapshot(2, 0);
            PROCESSENTRY32 e = new PROCESSENTRY32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (snap != IntPtr.Zero && snap != new IntPtr(-1))
            {
                for (bool ok = Process32First(snap, ref e); ok; ok = Process32Next(snap, ref e))
                {
                    Proc p = new Proc(); p.pid = e.th32ProcessID; p.ppid = e.th32ParentProcessID; p.name = e.szExeFile;
                    IntPtr h = OpenProcess(LIMITED, false, p.pid);
                    if (h != IntPtr.Zero)
                    {
                        FILETIME c, x, k, u;
                        if (GetProcessTimes(h, out c, out x, out k, out u)) { p.start = UnixMs(c); p.cpuMs = (Ticks(k) + Ticks(u)) / 10000; }
                        PMC m; if (GetProcessMemoryInfo(h, out m, (uint)Marshal.SizeOf(typeof(PMC)))) p.wsKb = (long)((ulong)m.WorkingSetSize / 1024);
                        p.prio = GetPriorityClass(h);
                        CloseHandle(h);
                    }
                    procs.Add(p);
                }
                CloseHandle(snap);
            }
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            // Grow the tree of the root: a process joins when its parent is in it and started no earlier than that parent.
            // A parent that already exited (Git Bash forks, then execs) stays known for ten minutes, so its orphans still join.
            Dictionary<uint, Proc> byPid = new Dictionary<uint, Proc>();
            foreach (Proc p in procs) byPid[p.pid] = p;
            List<Proc> joined = new List<Proc>();
            for (bool grew = true; grew; )
            {
                grew = false;
                foreach (Proc p in procs)
                {
                    Known k;
                    if (tree.TryGetValue(p.pid, out k) && k.start == p.start) { k.seen = now; continue; }
                    if (p.pid == root || p.pid == 0 || p.start == 0) continue;
                    Known parent;
                    bool child = p.ppid == root || (tree.TryGetValue(p.ppid, out parent) && p.start >= parent.start - 2000);
                    if (!child) continue;
                    tree[p.pid] = new Known { start = p.start, seen = now };
                    joined.Add(p); grew = true;
                }
            }
            List<uint> gone = new List<uint>();
            foreach (KeyValuePair<uint, Known> kv in tree) if (now - kv.Value.seen > 600000) gone.Add(kv.Key);
            foreach (uint g in gone) tree.Remove(g);
            foreach (Proc p in joined) { string cmd = CommandLine(p.pid); if (cmd != null) p.cmd = cmd.Length > 200 ? cmd.Substring(0, 200) : cmd; }

            FILETIME i1, k1, u1; GetSystemTimes(out i1, out k1, out u1);
            long total = Ticks(k1) + Ticks(u1), idle = Ticks(i1);
            double cpu = -1;
            if (!first && total > lastTotal) cpu = 100.0 * (1.0 - (double)(idle - lastIdle) / (double)(total - lastTotal));
            lastIdle = idle; lastTotal = total; first = false;
            MEMORYSTATUSEX ms = new MEMORYSTATUSEX(); ms.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX)); GlobalMemoryStatusEx(ref ms);
            LASTINPUTINFO li = new LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            double idleS = -1; if (GetLastInputInfo(ref li)) idleS = (uint)(Environment.TickCount - (int)li.dwTime) / 1000.0;

            StringBuilder sb = new StringBuilder(procs.Count * 70 + 200);
            sb.Append("{\"t\":").Append(now);
            sb.Append(",\"cpu\":").Append(cpu < 0 ? "null" : Math.Max(0, Math.Min(100, cpu)).ToString("0.0", CultureInfo.InvariantCulture));
            sb.Append(",\"mem\":[").Append((ms.ullTotalPhys - ms.ullAvailPhys) / 1048576).Append(',').Append(ms.ullTotalPhys / 1048576).Append(']');
            sb.Append(",\"idle\":").Append(idleS < 0 ? "null" : idleS.ToString("0.0", CultureInfo.InvariantCulture));
            sb.Append(",\"pid\":").Append(Process.GetCurrentProcess().Id).Append(",\"p\":[");
            for (int n = 0; n < procs.Count; n++)
            {
                Proc p = procs[n];
                if (n > 0) sb.Append(',');
                sb.Append('[').Append(p.pid).Append(',').Append(p.ppid).Append(',').Append(p.start).Append(',');
                Escape(sb, p.name);
                sb.Append(',').Append(p.cpuMs).Append(',').Append(p.wsKb).Append(',').Append(p.prio);
                if (p.cmd != null) { sb.Append(','); Escape(sb, p.cmd); }
                sb.Append(']');
            }
            sb.Append("]}");
            Console.Out.WriteLine(sb.ToString()); Console.Out.Flush();
            int wait = interval - (int)(pace.ElapsedMilliseconds % interval);
            Thread.Sleep(Math.Max(100, wait));
        }
    }
}
`;
