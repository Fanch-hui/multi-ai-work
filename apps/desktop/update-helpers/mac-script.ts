export const macUpdateHelper = String.raw`ObjC.import('Foundation');
ObjC.bindFunction('renameatx_np', ['int', ['int', 'char*', 'int', 'char*', 'unsigned int']]);
ObjC.bindFunction('kill', ['int', ['int', 'int']]);

function run(argv) {
  var config = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null)));
  var fm = $.NSFileManager.defaultManager;
  function write(path, value) {
    if (!$(JSON.stringify(value)).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)) throw Error('Cannot write update receipt');
  }
  function task(executable, args) {
    var process = $.NSTask.alloc.init;
    process.launchPath = executable;
    process.arguments = args;
    process.standardOutput = $.NSFileHandle.fileHandleWithNullDevice;
    process.standardError = $.NSFileHandle.fileHandleWithNullDevice;
    process.launch;
    process.waitUntilExit;
    if (process.terminationStatus !== 0) throw Error('Update command failed: ' + executable);
  }
  function remove(path) {
    if (fm.fileExistsAtPath(path) && !fm.removeItemAtPathError(path, null)) throw Error('Cannot remove update staging');
  }
  var parentExited = false;
  try {
    if (!fm.fileExistsAtPath(config.stagePath) || !fm.fileExistsAtPath(config.targetPath)) throw Error('Update staging is missing');
    write(config.readyPath, { ready: true });
    var deadline = Date.now() + 120000;
    while ($.kill(config.parentPid, 0) === 0) {
      if (fm.fileExistsAtPath(config.cancelPath)) return;
      if (Date.now() >= deadline) throw Error('Application did not exit within 120 seconds');
      $.NSThread.sleepForTimeInterval(0.2);
    }
    parentExited = true;
    if (fm.fileExistsAtPath(config.cancelPath)) return;
    if ($.renameatx_np(-2, config.stagePath, -2, config.targetPath, 2) !== 0) throw Error('Atomic application replacement failed');
    remove(config.stagePath);
    write(config.receiptPath, { status: 'installed', version: config.version });
  } catch (error) {
    write(config.receiptPath, { status: 'failed', version: config.version, message: String(error.message || error) });
  } finally {
    try { remove(config.stagePath); } catch (_) {}
    try { remove(config.packagePath); } catch (_) {}
    try { remove(config.jobDirectory); } catch (_) {}
  }
  if (parentExited) {
    try { task('/usr/bin/open', ['-n', config.targetPath]); } catch (_) {
      write(config.receiptPath, { status: 'failed', version: config.version, message: 'Could not reopen application' });
    }
  }
}
`;
