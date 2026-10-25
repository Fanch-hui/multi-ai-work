import AVFoundation
import Darwin
import Foundation
import Speech

struct SpeechOptions {
  let status: Bool
  let language: String
  let maximumDuration: TimeInterval

  init(_ arguments: [String]) throws {
    var status = false
    var recognize = false
    var language = Locale.preferredLanguages.first ?? Locale.current.identifier
    var duration = 45_000
    var index = 0
    while index < arguments.count {
      switch arguments[index] {
      case "--status": status = true
      case "--recognize": recognize = true
      case "--language", "--max-duration-ms":
        let name = arguments[index]
        index += 1
        guard index < arguments.count else { throw SpeechFailure("缺少语音识别参数") }
        if name == "--language" { language = arguments[index] }
        else {
          guard let value = Int(arguments[index]), (250...45_000).contains(value) else {
            throw SpeechFailure("语音录音时长必须在 250 到 45000 毫秒之间")
          }
          duration = value
        }
      default: throw SpeechFailure("语音识别参数无效")
      }
      index += 1
    }
    guard status != recognize, !language.isEmpty, language.count <= 64 else {
      throw SpeechFailure("请指定语音识别操作和语言")
    }
    self.status = status
    self.language = language
    self.maximumDuration = Double(duration) / 1000
  }
}

struct SpeechFailure: Error {
  let message: String
  init(_ message: String) { self.message = message }
}

func emit(_ value: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
  try? FileHandle.standardOutput.write(contentsOf: data + Data([10]))
}

func speechLocale(_ language: String) -> Locale? {
  let requested = language.replacingOccurrences(of: "_", with: "-").lowercased()
  let defaults = ["zh": "zh-cn", "en": "en-us"]
  let preferred = defaults[requested] ?? requested
  let base = requested.split(separator: "-").first.map(String.init) ?? requested
  let locales = SFSpeechRecognizer.supportedLocales().sorted { $0.identifier < $1.identifier }
  return locales.first { $0.identifier.replacingOccurrences(of: "_", with: "-").lowercased() == preferred }
    ?? locales.first { $0.identifier.replacingOccurrences(of: "_", with: "-").lowercased().hasPrefix(base + "-") }
}

func recognitionStatus(_ language: String) -> [String: Any] {
  guard let locale = speechLocale(language), let recognizer = SFSpeechRecognizer(locale: locale) else {
    return ["available": false, "locale": language, "authorization": "unavailable",
      "reason": "系统语音识别不支持所选语言，请更换听写语言"]
  }
  let speech = SFSpeechRecognizer.authorizationStatus()
  let microphone = AVCaptureDevice.authorizationStatus(for: .audio)
  let authorization: String
  var reason: String?
  if speech == .denied || microphone == .denied {
    authorization = "denied"
    reason = speech == .denied
      ? "请在系统设置 → 隐私与安全性 → 语音识别中允许 multi-AI work"
      : "请在系统设置 → 隐私与安全性 → 麦克风中允许 multi-AI work"
  } else if speech == .restricted || microphone == .restricted {
    authorization = "restricted"
    reason = "系统限制了语音识别或麦克风访问，请检查设备限制"
  } else if speech == .notDetermined || microphone == .notDetermined {
    authorization = "not_determined"
  } else {
    authorization = "authorized"
    if !recognizer.isAvailable { reason = "系统语音识别暂不可用，请检查听写语言和网络后重试" }
  }
  var result: [String: Any] = ["available": reason == nil, "locale": locale.identifier,
    "authorization": authorization]
  if let reason { result["reason"] = reason }
  return result
}

@MainActor
final class SpeechSession {
  private let options: SpeechOptions
  private var engine: AVAudioEngine?
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var timer: Timer?
  private var finishTimer: Timer?
  private var signals: [DispatchSourceSignal] = []
  private var tapInstalled = false
  private var finished = false
  private var finishing = false
  private var text = ""

  init(_ options: SpeechOptions) { self.options = options }

  func start() {
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    signal(SIGPIPE, SIG_IGN)
    for number in [SIGINT, SIGTERM] {
      let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
      source.setEventHandler { [weak self] in self?.cancel() }
      source.resume()
      signals.append(source)
    }
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      while let command = readLine() {
        DispatchQueue.main.async {
          if command == "stop" { self?.stop() }
          else if command == "cancel" { self?.cancel() }
          else { self?.fail("语音识别控制命令无效") }
        }
      }
      DispatchQueue.main.async {
        if self?.finishing == false { self?.cancel() }
      }
    }
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: authorizeMicrophone()
    case .notDetermined:
      SFSpeechRecognizer.requestAuthorization { [weak self] value in
        DispatchQueue.main.async {
          guard let self, !self.finished else { return }
          if value == .authorized { self.authorizeMicrophone() }
          else { self.fail("请在系统设置 → 隐私与安全性 → 语音识别中允许 multi-AI work") }
        }
      }
    default: fail("请在系统设置 → 隐私与安全性 → 语音识别中允许 multi-AI work")
    }
  }

  private func authorizeMicrophone() {
    guard !finished else { return }
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: beginRecording()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .audio) { [weak self] allowed in
        DispatchQueue.main.async {
          guard let self, !self.finished else { return }
          if allowed { self.beginRecording() }
          else { self.fail("请在系统设置 → 隐私与安全性 → 麦克风中允许 multi-AI work") }
        }
      }
    default: fail("请在系统设置 → 隐私与安全性 → 麦克风中允许 multi-AI work")
    }
  }

  private func beginRecording() {
    guard let locale = speechLocale(options.language),
      let recognizer = SFSpeechRecognizer(locale: locale) else {
      fail("系统语音识别不支持所选语言，请更换听写语言")
      return
    }
    guard recognizer.isAvailable else {
      fail("系统语音识别暂不可用，请检查听写语言和网络后重试")
      return
    }
    recognizer.queue = .main
    self.recognizer = recognizer
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    request.addsPunctuation = true
    request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
    self.request = request
    let engine = AVAudioEngine()
    self.engine = engine
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      fail("麦克风没有可用输入，请检查系统输入设备")
      return
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      request.append(buffer)
    }
    tapInstalled = true
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      guard let self, !self.finished else { return }
      if let result {
        self.text = result.bestTranscription.formattedString
        if result.isFinal { self.complete(); return }
      }
      if let error { self.recognitionFailed(error as NSError) }
    }
    do {
      engine.prepare()
      try engine.start()
      timer = Timer.scheduledTimer(withTimeInterval: options.maximumDuration, repeats: false) { [weak self] _ in
        MainActor.assumeIsolated { self?.stop() }
      }
      emit(["type": "ready"])
    } catch { fail("无法启动麦克风，请检查系统输入设备和权限") }
  }

  func stop() {
    guard !finished, !finishing else { return }
    finishing = true
    stopAudio()
    guard let request, let task else { complete(); return }
    request.endAudio()
    task.finish()
    finishTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.complete() }
    }
  }

  func cancel() {
    guard !finished else { return }
    finished = true
    release()
    emit(["type": "result", "text": ""])
    exit(0)
  }

  private func recognitionFailed(_ error: NSError) {
    if error.domain == "kAFAssistantErrorDomain" && error.code == 1110 { complete(); return }
    let message: String
    switch (error.domain, error.code) {
    case ("kLSRErrorDomain", 102): message = "系统语音语言资源尚未安装，请在系统设置中启用对应语言的听写"
    case ("kLSRErrorDomain", 201): message = "请在系统设置 → 键盘中启用听写"
    case ("kAFAssistantErrorDomain", 1700): message = "请在系统设置 → 隐私与安全性 → 语音识别中允许 multi-AI work"
    case ("kAFAssistantErrorDomain", 1100): message = "系统语音识别正被占用，请结束其他识别后重试"
    default: message = "系统语音识别失败，请检查听写语言和网络后重试"
    }
    fail(message)
  }

  private func stopAudio() {
    timer?.invalidate()
    timer = nil
    engine?.stop()
    if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }
  }

  private func release() {
    stopAudio()
    finishTimer?.invalidate()
    finishTimer = nil
    request?.endAudio()
    task?.cancel()
    request = nil
    task = nil
    recognizer = nil
    engine = nil
    for source in signals { source.cancel() }
    signals = []
  }

  private func complete() {
    guard !finished else { return }
    finished = true
    release()
    emit(["type": "result", "text": text])
    exit(0)
  }

  private func fail(_ message: String) {
    guard !finished else { return }
    finished = true
    release()
    emit(["type": "error", "message": message])
    exit(1)
  }
}

@main
struct SpeechNative {
  @MainActor static func main() {
    do {
      let options = try SpeechOptions(Array(CommandLine.arguments.dropFirst()))
      if options.status { emit(recognitionStatus(options.language)); return }
      let session = SpeechSession(options)
      session.start()
      withExtendedLifetime(session) { RunLoop.main.run() }
    } catch {
      emit(["type": "error", "message": (error as? SpeechFailure)?.message ?? "语音识别启动失败"])
      exit(64)
    }
  }
}
