$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Write-Protocol($value) {
  [Console]::WriteLine(($value | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

try {
  $mode = ''
  $language = [Globalization.CultureInfo]::CurrentUICulture.Name
  $maximum = 45000
  for ($index = 0; $index -lt $args.Count; $index++) {
    switch ($args[$index]) {
      '--status' { if ($mode) { throw 'SPEECH_ARGUMENTS: Choose one operation' }; $mode = 'status' }
      '--recognize' { if ($mode) { throw 'SPEECH_ARGUMENTS: Choose one operation' }; $mode = 'recognize' }
      '--language' {
        $index++
        if ($index -ge $args.Count -or !$args[$index]) { throw 'SPEECH_ARGUMENTS: A language is required' }
        $language = $args[$index]
      }
      '--max-duration-ms' {
        $index++
        if ($index -ge $args.Count -or ![int]::TryParse($args[$index], [ref]$maximum) -or $maximum -lt 1 -or $maximum -gt 45000) {
          throw 'SPEECH_ARGUMENTS: Maximum duration must be 1 to 45000 milliseconds'
        }
      }
      default { throw 'SPEECH_ARGUMENTS: Unsupported argument' }
    }
  }
  if (!$mode) { throw 'SPEECH_ARGUMENTS: An operation is required' }
  try { $culture = [Globalization.CultureInfo]::GetCultureInfo($language.Replace('_', '-')) }
  catch { throw 'SPEECH_ARGUMENTS: Language must be a valid locale' }
  Add-Type -AssemblyName System.Speech
  $recognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
  $recognizer = $recognizers | Where-Object { $_.Culture.Name -eq $culture.Name } | Select-Object -First 1
  if (!$recognizer -and $culture.IsNeutralCulture) {
    $recognizer = $recognizers | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $culture.TwoLetterISOLanguageName } | Select-Object -First 1
  }
  if (!$recognizer) {
    $reason = 'SPEECH_LANGUAGE_MISSING: Install the requested speech recognition language in Windows language settings'
    if ($mode -eq 'status') {
      Write-Protocol @{ available = $false; locale = $culture.Name; authorization = 'unavailable'; reason = $reason }
      exit 0
    }
    throw $reason
  }
  if ($mode -eq 'status') {
    Write-Protocol @{ available = $true; locale = $recognizer.Culture.Name; authorization = 'not_determined' }
    exit 0
  }

  $source = @'
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Speech.Recognition;
using System.Threading;
using System.Threading.Tasks;

namespace MultiAiWork {
  public sealed class SpeechCapture : IDisposable {
    private readonly SpeechRecognitionEngine engine;
    private readonly ManualResetEventSlim completed = new ManualResetEventSlim(false);
    private readonly ConcurrentQueue<string> commands = new ConcurrentQueue<string>();
    private readonly List<string> phrases = new List<string>();
    private readonly object gate = new object();
    private Exception failure;
    private bool started;
    private bool disposed;

    public SpeechCapture(string recognizerId) {
      engine = new SpeechRecognitionEngine(recognizerId);
      engine.LoadGrammar(new DictationGrammar());
      engine.InitialSilenceTimeout = TimeSpan.FromSeconds(7);
      engine.BabbleTimeout = TimeSpan.FromSeconds(15);
      engine.EndSilenceTimeout = TimeSpan.FromMilliseconds(900);
      engine.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(1200);
      engine.SpeechRecognized += OnRecognized;
      engine.RecognizeCompleted += OnCompleted;
    }

    public string Run(int maximum) {
      Task.Factory.StartNew(ReadCommands, TaskCreationOptions.LongRunning);
      engine.SetInputToDefaultAudioDevice();
      engine.RecognizeAsync(RecognizeMode.Multiple);
      started = true;
      Console.WriteLine("{\"type\":\"ready\"}");
      Console.Out.Flush();
      var elapsed = Stopwatch.StartNew();
      bool stopping = false;
      long stopAt = 0;
      while (!completed.Wait(40)) {
        string command;
        while (commands.TryDequeue(out command)) {
          if (command == "cancel") {
            engine.RecognizeAsyncCancel();
            completed.Wait(2000);
            return null;
          }
          if (command == "stop" && !stopping) {
            engine.RecognizeAsyncStop();
            stopping = true;
            stopAt = elapsed.ElapsedMilliseconds;
          }
        }
        if (!stopping && elapsed.ElapsedMilliseconds >= maximum) {
          engine.RecognizeAsyncStop();
          stopping = true;
          stopAt = elapsed.ElapsedMilliseconds;
        }
        if (stopping && elapsed.ElapsedMilliseconds - stopAt >= 2500) {
          engine.RecognizeAsyncCancel();
          completed.Wait(500);
          break;
        }
      }
      if (failure != null) throw failure;
      lock (gate) return String.Join(" ", phrases.ToArray());
    }

    private void ReadCommands() {
      while (true) {
        string line = Console.ReadLine();
        if (line == null || line == "cancel") {
          commands.Enqueue("cancel");
          return;
        }
        if (line == "stop") commands.Enqueue("stop");
      }
    }

    private void OnRecognized(object sender, SpeechRecognizedEventArgs args) {
      if (String.IsNullOrWhiteSpace(args.Result.Text)) return;
      lock (gate) {
        if (disposed) return;
        phrases.Add(args.Result.Text);
      }
    }

    private void OnCompleted(object sender, RecognizeCompletedEventArgs args) {
      lock (gate) {
        if (disposed) return;
        failure = args.Error;
        completed.Set();
      }
    }

    public void Dispose() {
      lock (gate) {
        if (disposed) return;
        disposed = true;
      }
      if (started && !completed.IsSet) engine.RecognizeAsyncCancel();
      engine.SpeechRecognized -= OnRecognized;
      engine.RecognizeCompleted -= OnCompleted;
      engine.Dispose();
      completed.Dispose();
    }
  }
}
'@
  Add-Type -TypeDefinition $source -ReferencedAssemblies System.Speech, System.Core
  $capture = [MultiAiWork.SpeechCapture]::new($recognizer.Id)
  try {
    $text = $capture.Run($maximum)
    if ($null -eq $text) { Write-Protocol @{ type = 'cancelled' } }
    else { Write-Protocol @{ type = 'result'; text = $text } }
  } finally {
    $capture.Dispose()
  }
} catch {
  $failure = $_.Exception.GetBaseException()
  $message = $failure.Message
  if ($failure -is [UnauthorizedAccessException] -or $failure.HResult -eq -2147024891) {
    $message = 'SPEECH_PERMISSION_DENIED: Allow desktop applications to access the microphone in Windows privacy settings'
  }
  if ($mode -eq 'status' -and !$message.StartsWith('SPEECH_ARGUMENTS:')) {
    Write-Protocol @{ available = $false; locale = $language; authorization = 'unavailable'; reason = "SYSTEM_SPEECH_UNAVAILABLE: $message" }
    exit 0
  }
  Write-Protocol @{ type = 'error'; message = $message }
  exit 1
}
