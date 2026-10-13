param(
  [int]$Modifiers = 3,
  [int]$Key = 32,
  [string]$Culture = '',
  [switch]$ListRecognizers
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Speech
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class HotKeyWindow : NativeWindow, IDisposable {
  [DllImport("user32.dll", SetLastError=true)]
  static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint key);
  [DllImport("user32.dll", SetLastError=true)]
  static extern bool UnregisterHotKey(IntPtr h, int id);
  public event EventHandler Pressed;
  public HotKeyWindow(uint mod, uint key) {
    CreateParams p = new CreateParams();
    p.Parent = new IntPtr(-3);
    CreateHandle(p);
    if (!RegisterHotKey(Handle, 1, mod, key)) {
      DestroyHandle();
      throw new InvalidOperationException("HOTKEY_TAKEN");
    }
  }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x0312) {
      var h = Pressed;
      if (h != null) h(this, EventArgs.Empty);
    }
    base.WndProc(ref m);
  }
  public void Dispose() {
    UnregisterHotKey(Handle, 1);
    DestroyHandle();
  }
}
public class QuietForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
}
'@
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$outDir = Join-Path $repo 'bridge\ptt'
[IO.Directory]::CreateDirectory($outDir) | Out-Null
$logFile = Join-Path $outDir 'ptt.log'
function LogError([string]$Message) {
  [IO.File]::AppendAllText($logFile, "$(Get-Date -Format o) $Message`r`n", [Text.Encoding]::UTF8)
}
$recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
if ($ListRecognizers) {
  $recognizers | ForEach-Object { Write-Output ($_.Culture.Name + ' ' + $_.Description) }
  exit 0
}
if (-not $Culture) {
  if ($recognizers | Where-Object { $_.Culture.Name -eq 'pt-BR' }) { $Culture = 'pt-BR' } else { $Culture = 'en-US' }
}
$match = $recognizers | Where-Object { $_.Culture.Name -eq $Culture } | Select-Object -First 1
if (-not $match) {
  LogError "No speech recognizer installed for $Culture"
  exit 2
}
$engine = $null
$window = $null
$form = $null
$recording = $false
$resultText = ''
$confidence = 0.0
$done = $false
try {
  $engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($match)
  $engine.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
  $engine.SetInputToDefaultAudioDevice()
  $engine.BabbleTimeout = [TimeSpan]::FromSeconds(8)
  $engine.EndSilenceTimeout = [TimeSpan]::FromSeconds(8)
  $engine.add_SpeechRecognized({
    param($sender, $event)
    $script:resultText = $event.Result.Text
    $script:confidence = $event.Result.Confidence
  })
  $engine.add_RecognizeCompleted({
    param($sender, $event)
    if ($event.Error) { LogError $event.Error.Message }
    $script:done = $true
  })
  $window = [HotKeyWindow]::new([uint32]$Modifiers, [uint32]$Key)
  $window.add_Pressed({
    if (-not $script:recording) {
      if (Test-Path -LiteralPath (Join-Path $repo 'bridge\KILLED')) {
        LogError 'Recording blocked: AI kill switch is active.'
        return
      }
      $script:recording = $true
      $script:done = $false
      $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
    } else {
      $engine.RecognizeAsyncCancel()
      $script:done = $true
    }
  })
  $timer = New-Object Windows.Forms.Timer
  $timer.Interval = 100
  $timer.add_Tick({
    if ($script:recording -and $script:done) {
      $script:recording = $false
      $engine.RecognizeAsyncStop()
      if ($script:resultText) {
        $form.Show()
        $inputBox.Text = $script:resultText
        $confidenceLabel.Text = ('Confidence: {0:N2}' -f $script:confidence)
        if ($script:confidence -lt 0.6) {
          $confidenceLabel.ForeColor = [Drawing.Color]::Red
        }
      }
    }
  })
  $form = [QuietForm]::new()
  $form.Text = 'Runback push-to-talk'
  $form.TopMost = $true
  $form.Size = New-Object Drawing.Size(430, 150)
  $form.StartPosition = 'CenterScreen'
  $inputBox = New-Object Windows.Forms.TextBox
  $inputBox.Multiline = $true
  $inputBox.Size = New-Object Drawing.Size(400, 50)
  $inputBox.Location = New-Object Drawing.Point(10, 10)
  $form.Controls.Add($inputBox)
  $confidenceLabel = New-Object Windows.Forms.Label
  $confidenceLabel.Location = New-Object Drawing.Point(10, 68)
  $confidenceLabel.Size = New-Object Drawing.Size(180, 20)
  $form.Controls.Add($confidenceLabel)
  $send = New-Object Windows.Forms.Button
  $send.Text = 'Send'
  $send.Location = New-Object Drawing.Point(250, 90)
  $send.add_Click({
    try {
      $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $record = @{
        text = $inputBox.Text
        at = $at
        confidence = $script:confidence
      } | ConvertTo-Json -Compress
      $target = Join-Path $outDir "$at.json"
      $temp = "$target.tmp"
      [IO.File]::WriteAllText($temp, $record, (New-Object Text.UTF8Encoding($false)))
      [IO.File]::Move($temp, $target)
      $form.Hide()
    } catch { LogError $_.Exception.Message }
  })
  $form.Controls.Add($send)
  $cancel = New-Object Windows.Forms.Button
  $cancel.Text = 'Cancel'
  $cancel.Location = New-Object Drawing.Point(335, 90)
  $cancel.add_Click({ $form.Hide() })
  $form.Controls.Add($cancel)
  $timer.Start()
  [Windows.Forms.Application]::Run()
} catch {
  if ($_.Exception.Message -like '*HOTKEY_TAKEN*') {
    LogError 'Hotkey registration failed.'
    [Windows.Forms.MessageBox]::Show('Hotkey already taken by another program — pick another with -Key') | Out-Null
    exit 4
  }
  LogError $_.Exception.ToString()
  exit 1
} finally {
  if ($engine) { $engine.Dispose() }
  if ($window) { $window.Dispose() }
}
