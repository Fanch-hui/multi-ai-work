import AppKit
import ApplicationServices
import ScreenCaptureKit

struct NativeFailure: Error { let message: String }
func fail(_ message: String) throws -> Never { throw NativeFailure(message: message) }
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var result: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
}
func string(_ element: AXUIElement, _ name: String) -> String {
  return attribute(element, name) as? String ?? ""
}
func secure(_ element: AXUIElement) -> Bool {
  let label = [string(element, kAXRoleAttribute), string(element, kAXSubroleAttribute),
    string(element, kAXTitleAttribute), string(element, kAXDescriptionAttribute),
    string(element, kAXHelpAttribute)].joined(separator: " ").lowercased()
  return ["secure", "password", "passcode", "verification", "one-time", "token", "secret",
    "密码", "验证码", "口令", "密钥", "登录", "sign in", "log in", "login"].contains { label.contains($0) }
}
func label(_ element: AXUIElement) -> String {
  if secure(element) { return "[需要人工处理的敏感控件]" }
  return String([string(element, kAXTitleAttribute), string(element, kAXDescriptionAttribute),
    string(element, kAXHelpAttribute)].first { !$0.isEmpty }?.prefix(160) ?? "")
}

final class ComputerNative {
  var revision = ""
  var bundleId = ""
  var windowId: UInt32 = 0
  var window: AXUIElement?
  var refs: [String: AXUIElement] = [:]
  var signature = ""
  var sensitive = false

  func application(_ bundle: String) throws -> NSRunningApplication {
    guard let app = NSWorkspace.shared.runningApplications.first(where: {
      $0.bundleIdentifier == bundle && $0.activationPolicy == .regular
    }) else { try fail("应用尚未运行，请先打开应用") }
    return app
  }
  func requireAccess() throws {
    if !AXIsProcessTrusted() { try fail("请在系统设置 → 隐私与安全性 → 辅助功能中允许 multi-AI work") }
  }
  func elements(_ root: AXUIElement, store: Bool) -> [[String: Any]] {
    var output: [[String: Any]] = []
    var visited = 0
    var foundSensitive = false
    func walk(_ element: AXUIElement, _ depth: Int) {
      if visited >= 1200 || output.count >= 300 || depth > 14 { return }
      visited += 1
      if secure(element) {
        foundSensitive = true
        return
      }
      let role = string(element, kAXRoleAttribute)
      let name = label(element)
      let editable = [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role)
      if !name.isEmpty || editable || [kAXButtonRole, kAXCheckBoxRole, kAXRadioButtonRole].contains(role) {
        let ref = "e\(output.count + 1)"
        output.append(["ref": ref, "role": role, "name": name, "editable": editable])
        if store { refs[ref] = element }
      }
      if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
        for child in children { walk(child, depth + 1) }
      }
    }
    walk(root, 0)
    if store { sensitive = foundSensitive }
    return output
  }
  func fingerprint(_ nodes: [[String: Any]]) -> String {
    let data = try? JSONSerialization.data(withJSONObject: nodes, options: [.sortedKeys])
    return data?.base64EncodedString() ?? ""
  }
  func targetWindow(_ app: NSRunningApplication, requested: UInt32?) throws -> (AXUIElement, UInt32) {
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    guard let windows = attribute(axApp, kAXWindowsAttribute) as? [AXUIElement], !windows.isEmpty else {
      try fail("应用没有可读取的窗口")
    }
    let records = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let own = records.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }
    guard let record = own.first(where: { requested == nil || ($0[kCGWindowNumber as String] as? UInt32) == requested }),
      let number = record[kCGWindowNumber as String] as? UInt32 else { try fail("应用窗口已变化，请重新观察") }
    guard let bounds = record[kCGWindowBounds as String] as? [String: Any],
      let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { try fail("窗口范围不可读取") }
    let matching = windows.filter { candidate in
      guard let position = attribute(candidate, kAXPositionAttribute), let size = attribute(candidate, kAXSizeAttribute),
        CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return false }
      var point = CGPoint.zero
      var dimensions = CGSize.zero
      if !AXValueGetValue(position as! AXValue, .cgPoint, &point) || !AXValueGetValue(size as! AXValue, .cgSize, &dimensions) { return false }
      return abs(point.x - rect.origin.x) < 3 && abs(point.y - rect.origin.y) < 3 && abs(dimensions.width - rect.width) < 3 && abs(dimensions.height - rect.height) < 3
    }
    guard matching.count == 1 else { try fail("无法精确定位应用窗口，请人工接管") }
    return (matching[0], number)
  }
  func observe(_ input: [String: Any]) async throws -> [String: Any] {
    try requireAccess()
    guard let bundle = input["bundleId"] as? String else { try fail("缺少应用标识") }
    let app = try application(bundle)
    let (selected, number) = try targetWindow(app, requested: input["windowId"] as? UInt32)
    refs = [:]
    let nodes = elements(selected, store: true)
    window = selected
    bundleId = bundle
    windowId = number
    revision = UUID().uuidString
    signature = fingerprint(nodes)
    var result: [String: Any] = ["revision": revision, "bundleId": bundle,
      "windowId": number, "title": label(selected), "elements": nodes, "sensitive": sensitive]
    if input["screenshot"] as? Bool == true {
      if sensitive { try fail("窗口包含登录或敏感控件，请人工接管后处理") }
      if !CGPreflightScreenCaptureAccess() { try fail("请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许 multi-AI work") }
      if #available(macOS 14.0, *) {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let screenWindow = content.windows.first(where: { $0.windowID == number }) else { try fail("窗口已关闭") }
        let config = SCStreamConfiguration()
        config.width = max(1, min(2048, Int(screenWindow.frame.width)))
        config.height = max(1, min(2048, Int(screenWindow.frame.height)))
        config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: screenWindow), configuration: config)
        let bitmap = NSBitmapImageRep(cgImage: image)
        result["screenshot"] = bitmap.representation(using: .png, properties: [:])?.base64EncodedString()
      } else { try fail("窗口截图需要 macOS 14 或更高版本") }
    }
    return result
  }
  func action(_ input: [String: Any]) throws -> [String: Any] {
    try requireAccess()
    guard input["revision"] as? String == revision, !revision.isEmpty, let selected = window else {
      try fail("请先重新观察应用窗口")
    }
    let app = try application(bundleId)
    let (current, _) = try targetWindow(app, requested: windowId)
    if !CFEqual(current, selected) { revision = ""; try fail("窗口已更换，请重新观察") }
    if fingerprint(elements(selected, store: false)) != signature { revision = ""; try fail("窗口已变化，请重新观察") }
    let element = refs[input["ref"] as? String ?? ""]
    if let target = element, secure(target) { try fail("敏感输入请人工接管") }
    guard let operation = input["action"] as? String else { try fail("缺少操作") }
    defer { revision = "" }
    if operation == "click" {
      guard let target = element else { try fail("请提供可点击控件 ref") }
      let result = AXUIElementPerformAction(target, kAXPressAction as CFString)
      if result != .success { try fail("控件不支持直接点击，请人工接管") }
    } else if operation == "fill" {
      guard let target = element, let text = input["text"] as? String, text.count <= 20000,
        [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(string(target, kAXRoleAttribute)) else {
        try fail("请选择可编辑文本控件")
      }
      if AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, text as CFString) != .success {
        try fail("应用不支持直接输入，请人工接管")
      }
    } else if operation == "press" || operation == "scroll" {
      if sensitive { try fail("登录或敏感窗口请人工接管") }
      app.activate(options: [])
      AXUIElementPerformAction(selected, kAXRaiseAction as CFString)
      guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { try fail("请将获准应用置于前台后重试") }
      let focusedApp = AXUIElementCreateApplication(app.processIdentifier)
      guard let focusedWindow = attribute(focusedApp, kAXFocusedWindowAttribute), CFEqual(focusedWindow, selected) else { try fail("前台窗口已更换，请重新观察") }
      guard let focused = attribute(focusedApp, kAXFocusedUIElementAttribute) else { try fail("应用没有输入焦点") }
      if secure(focused as! AXUIElement) { try fail("敏感输入请人工接管") }
      if operation == "press" {
        let keys: [String: CGKeyCode] = ["Enter": 36, "Tab": 48, "Escape": 53, "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126, "Backspace": 51, "Space": 49, "Meta+A": 0, "Meta+S": 1, "Meta+F": 3, "Meta+Z": 6, "Meta+Shift+Z": 6]
        let name = input["key"] as? String ?? ""
        guard let key = keys[name] else { try fail("此快捷键未获准") }
        var flags: CGEventFlags = []
        if name.contains("Meta+") { flags.insert(.maskCommand) }
        if name.contains("Shift+") { flags.insert(.maskShift) }
        for down in [true, false] {
          let event = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down)
          event?.flags = flags
          event?.postToPid(app.processIdentifier)
        }
      } else {
        guard let delta = input["deltaY"] as? Int, abs(delta) <= 1200 else { try fail("滚动范围应在 -1200 至 1200") }
        CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(delta), wheel2: 0, wheel3: 0)?.postToPid(app.processIdentifier)
      }
    } else { try fail("不支持此操作") }
    return ["ok": true]
  }
  func request(_ input: [String: Any]) async throws -> [String: Any] {
    switch input["method"] as? String {
    case "computer.capabilities":
      return ["available": true, "accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess()]
    case "computer.apps":
      let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil }.map {
        ["bundleId": $0.bundleIdentifier!, "name": $0.localizedName ?? $0.bundleIdentifier!, "pid": $0.processIdentifier] as [String: Any]
      }
      return ["apps": apps]
    case "computer.observe": return try await observe(input)
    case "computer.action": return try action(input)
    case "computer.release": revision = ""; refs = [:]; window = nil; return ["ok": true]
    default: try fail("不支持的电脑操作")
    }
  }
}

@main struct Main {
  static func main() async {
    let host = ComputerNative()
    while let line = readLine() {
      var response: [String: Any] = [:]
      do {
        guard let data = line.data(using: .utf8), let input = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try fail("请求格式错误") }
        response["id"] = input["id"]
        response["result"] = try await host.request(input)
      } catch let error as NativeFailure { response["error"] = error.message }
      catch { response["error"] = "系统操作失败：\(error.localizedDescription)" }
      if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) {
        print(text)
        fflush(stdout)
      }
    }
  }
}
