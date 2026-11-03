# Помощник: исполнитель команд мыши и клавиатуры (Windows SendInput).
# Читает команды построчно из stdin. Работает только пока идёт сеанс, разрешённый пользователем.
$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
public static class PInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  public static void Init() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch {} }
  }
  static void Send(INPUT i) { SendInput(1, new INPUT[]{ i }, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT M(int dx, int dy, int data, uint flags) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags; return i;
  }
  public static void Move(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    if (vw < 2 || vh < 2) return;
    int nx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
    int ny = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
    Send(M(nx, ny, 0, 0x0001 | 0x8000 | 0x4000)); // MOVE | ABSOLUTE | VIRTUALDESK
  }
  public static void Button(int b, bool down) {
    uint f = 0;
    if (b == 0) f = down ? 0x0002u : 0x0004u;
    else if (b == 2) f = down ? 0x0008u : 0x0010u;
    else if (b == 1) f = down ? 0x0020u : 0x0040u;
    else return;
    Send(M(0, 0, 0, f));
  }
  public static void Wheel(int delta, bool horizontal) { Send(M(0, 0, delta, horizontal ? 0x01000u : 0x0800u)); }
  public static void Key(ushort vk, bool down, bool ext) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
    uint f = 0; if (!down) f |= 0x0002; if (ext) f |= 0x0001; i.u.ki.dwFlags = f; Send(i);
  }
  public static void Text(string s) {
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') { Key(0x0D, true, false); Key(0x0D, false, false); continue; }
      INPUT a = new INPUT(); a.type = 1; a.u.ki.wScan = c; a.u.ki.dwFlags = 0x0004; Send(a);
      INPUT b = new INPUT(); b.type = 1; b.u.ki.wScan = c; b.u.ki.dwFlags = 0x0004 | 0x0002; Send(b);
    }
  }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
[PInput]::Init()
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
$stdin = [Console]::In
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Split(' ')
  try {
    switch ($p[0]) {
      'm' { [PInput]::Move([int]$p[1], [int]$p[2]) }
      'd' { [PInput]::Button([int]$p[1], $true) }
      'u' { [PInput]::Button([int]$p[1], $false) }
      'w' { [PInput]::Wheel([int]$p[1], $false) }
      'h' { [PInput]::Wheel([int]$p[1], $true) }
      'k' { [PInput]::Key([uint16]$p[1], ($p[2] -eq '1'), ($p[3] -eq '1')) }
      't' { [PInput]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))) }
      'q' { exit 0 }
    }
  } catch { }
}
