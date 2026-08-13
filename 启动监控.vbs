' AI 用量监控启动器：后台启动服务(无黑窗) + 打开独立小窗口
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir_ = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir_
' 启动服务（已在运行则自动退出，不会重复）
sh.Run "node """ & dir_ & "\server.js""", 0, False
WScript.Sleep 1200
' Edge 应用模式：无地址栏的独立小窗口
On Error Resume Next
sh.Run "msedge --app=http://127.0.0.1:38765/ --window-size=760,900", 1, False
If Err.Number <> 0 Then
  Err.Clear
  sh.Run "chrome --app=http://127.0.0.1:38765/ --window-size=760,900", 1, False
  If Err.Number <> 0 Then sh.Run "http://127.0.0.1:38765/", 1, False
End If
