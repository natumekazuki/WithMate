!include LogicLib.nsh

!define WITHMATE_WINDOWS_APPS_DIR "$LOCALAPPDATA\Microsoft\WindowsApps"
!define WITHMATE_MEMORY_ALIAS "${WITHMATE_WINDOWS_APPS_DIR}\withmate-memory.cmd"

!macro customInstall
  CreateDirectory "${WITHMATE_WINDOWS_APPS_DIR}"
  FileOpen $0 "${WITHMATE_MEMORY_ALIAS}" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "setlocal$\r$\n"
  FileWrite $0 "set ELECTRON_RUN_AS_NODE=1$\r$\n"
  FileWrite $0 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\resources\skills\withmate-memory\bin\withmate-memory.mjs" %*$\r$\n'
  FileWrite $0 "exit /b %ERRORLEVEL%$\r$\n"
  FileClose $0
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customUnInstall
  Delete "${WITHMATE_MEMORY_ALIAS}"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
