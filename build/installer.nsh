!include LogicLib.nsh

!define WITHMATE_WINDOWS_APPS_DIR "$LOCALAPPDATA\Microsoft\WindowsApps"
!define WITHMATE_GLOSSARY_ALIAS "${WITHMATE_WINDOWS_APPS_DIR}\withmate-glossary.cmd"
!define WITHMATE_LEGACY_GRAPH_ALIAS "${WITHMATE_WINDOWS_APPS_DIR}\withmate-session-graph.cmd"
!define WITHMATE_SESSION_ALIAS "${WITHMATE_WINDOWS_APPS_DIR}\withmate-session.cmd"

; 旧インストーラーがこのインストール先向けに書いたラッパーと照合する。
; WindowsApps は共有されるため、ファイル名だけでは所有元を特定できない。
!macro removeLegacyGraphAlias ALIAS_PATH
  ClearErrors
  FileOpen $0 "${ALIAS_PATH}" r
  IfErrors graph_alias_done

  FileRead $0 $1
  StrCmpS $1 "@echo off$\r$\n" 0 graph_alias_keep
  FileRead $0 $1
  StrCmpS $1 "setlocal$\r$\n" 0 graph_alias_keep
  FileRead $0 $1
  StrCmpS $1 "set ELECTRON_RUN_AS_NODE=1$\r$\n" 0 graph_alias_keep
  FileRead $0 $1
  StrCmpS $1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\resources\cli\withmate-session-graph.mjs" %*$\r$\n' 0 graph_alias_keep
  FileRead $0 $1
  StrCmpS $1 "exit /b %ERRORLEVEL%$\r$\n" 0 graph_alias_keep

  ; 末尾に追加された内容があれば、そのラッパーも一致とみなさない。
  FileReadByte $0 $1
  StrCmp $1 "" 0 graph_alias_keep
  FileClose $0
  Delete "${ALIAS_PATH}"
  Goto graph_alias_done

graph_alias_keep:
  FileClose $0
graph_alias_done:
  ClearErrors
!macroend

!macro customInstall
  !insertmacro removeLegacyGraphAlias "${WITHMATE_LEGACY_GRAPH_ALIAS}"
  ; 通常は旧アンインストーラーが削除する。
  ; 登録済みの旧アンインストーラーが実行されず、このインストール先に残ったファイルを削除する。
  Delete "$INSTDIR\withmate-session-graph.cmd"
  Delete "$INSTDIR\resources\resources\cli\withmate-session-graph.mjs"

  CreateDirectory "${WITHMATE_WINDOWS_APPS_DIR}"
  FileOpen $0 "${WITHMATE_GLOSSARY_ALIAS}" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "setlocal$\r$\n"
  FileWrite $0 "set ELECTRON_RUN_AS_NODE=1$\r$\n"
  FileWrite $0 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\resources\skills\withmate-glossary\bin\withmate-glossary.mjs" %*$\r$\n'
  FileWrite $0 "exit /b %ERRORLEVEL%$\r$\n"
  FileClose $0
  FileOpen $0 "${WITHMATE_SESSION_ALIAS}" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "setlocal$\r$\n"
  FileWrite $0 "set ELECTRON_RUN_AS_NODE=1$\r$\n"
  FileWrite $0 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\resources\cli\withmate-session.mjs" %*$\r$\n'
  FileWrite $0 "exit /b %ERRORLEVEL%$\r$\n"
  FileClose $0
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customUnInstall
  !insertmacro removeLegacyGraphAlias "${WITHMATE_LEGACY_GRAPH_ALIAS}"
  Delete "${WITHMATE_GLOSSARY_ALIAS}"
  Delete "${WITHMATE_SESSION_ALIAS}"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
