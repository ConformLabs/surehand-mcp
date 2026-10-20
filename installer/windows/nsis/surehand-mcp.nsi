; Surehand MCP: per-user Windows installer (Setup .exe), built with NSIS on macOS or Windows.
; Do not run makensis on this file directly: `npm run package:win-installer` (server/scripts/
; package-win-installer.mjs) downloads and verifies Node.js, builds the server and passes these defines:
;   VERSION        package version, e.g. 1.4.0           VERSION4    the same as a.b.c.d
;   NODE_EXE       verified official node.exe (win-x64)   NODE_VERSION e.g. 24.22.0
;   SERVER_MJS     the single-file server (server/dist/surehand-ae.mjs)
;   CL_RUN         installer/common/windows/cl-run.cjs   AI_APPS_NSH the AI app list (installer/ai-apps.mjs nsisApps)
;   ICON           the .ico                               OUTFILE     the Setup .exe to write
;   ESTIMATED_KB   installed size for Add/Remove Programs
;   SIGN_CMD       optional: a command that Authenticode-signs the file given as its last argument in place
;
; What it installs (the same places as installer/run.ps1 and `surehand-ae install`):
;   %USERPROFILE%\.surehand\node\node.exe                a private Node.js, shared by the Surehand apps (replaces an older private copy)
;   %USERPROFILE%\.surehand\ae\server\surehand-ae.mjs    the server; then `node surehand-ae.mjs install` moves a 1.3
;                                                      installation (%USERPROFILE%\.aemcp), installs the After Effects
;                                                      extension and writes the config, and `install --connect-only`
;                                                      connects each AI app ticked on "Choose AI apps"
;   %LOCALAPPDATA%\Programs\Surehand MCP\        the uninstaller and the icon (Add/Remove Programs entry)
;
; Pages: Update or uninstall (when it is installed) / Welcome, Choose AI apps (detected with `surehand-ae clients
; --json`; found ones ticked, the current connections when updating), the progress page's plain steps, and the
; finish page with what happened (the server's ~/.surehand/ae/install-result.json). A silent Setup (/S) shows nothing
; and connects every AI app it finds, as before.

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include LogicLib.nsh
!include x64.nsh
!include WinVer.nsh
!include FileFunc.nsh
!include "${AI_APPS_NSH}"

!define PRODUCT "Surehand MCP"
!define PUBLISHER "Ron Yitzhaki"
!define HOMEPAGE "https://github.com/ConformLabs/surehand-mcp"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SurehandMCP"
!define UNINST_EXE "Uninstall Surehand MCP.exe"
!define SUREHAND "$PROFILE\.surehand"
!define APPDIR "$PROFILE\.surehand\ae"
!define LEGACY "$PROFILE\.aemcp"
!define NODE_DIR "$PROFILE\.surehand\node"
!define SERVER_DIR "$PROFILE\.surehand\ae\server"
!define SERVER "$PROFILE\.surehand\ae\server\surehand-ae.mjs"
!define CEP_EXT "$APPDATA\Adobe\CEP\extensions\com.aemcp"
; what the server's install did (install.ts InstallResult), and the same as an INI for the finish page
!define RESULT_JSON "$PROFILE\.surehand\ae\install-result.json"

!ifdef SIGN_CMD
  ; runs after the installer / the uninstaller are written; %1 is the file
  !finalize '${SIGN_CMD} "%1"' = 0
  !uninstfinalize '${SIGN_CMD} "%1"' = 0
!endif

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT}"

VIProductVersion "${VERSION4}"
VIFileVersion "${VERSION4}"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey /LANG=1033 "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright (c) ${PUBLISHER}. MIT License."
VIAddVersionKey /LANG=1033 "Comments" "${HOMEPAGE}"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"

; --- the Conform Labs installer frame (installer/common): look, pages; this app's part below ---
!define CL_APP_NAME "${PRODUCT}"
!define CL_APP_VERSION "${VERSION}"
!define CL_ACCENT "3DD68C" ; installer/app.json accent.dark
!define CL_ART "${__FILEDIR__}\art" ; node installer/common/generate-art.mjs
!define CL_UNINST_KEY "${UNINST_KEY}"
!define CL_UNINST_EXE "${UNINST_EXE}"
!define CL_KEEP_NOTE "Next, you can change which AI apps are connected. Your settings and checkpoints are kept."
!define CL_UNINSTALL_NOTE "Removes the server, the Adobe® After Effects® extension and the AI app connections."
!define CL_UNINSTALL_ALL "Also remove my settings and checkpoints"
!define CL_AFTER_UNINSTALL AfterUninstall
!define CL_WELCOME_SUB "for Adobe® After Effects®"
!define CL_WELCOME_TEXT1 "Surehand lets the AI apps you use, like Claude, ChatGPT and Cursor, work in After Effects on this computer. Every edit is listed. You can undo it in After Effects."
!define CL_WELCOME_TEXT2 "It installs for your Windows account only. No administrator rights needed."
!define CL_WELCOME_TEXT3 "Next, you choose which AI apps to connect."
!define CL_INSTFILES_STEPS ListSteps
!define CL_RESULTS_INI "$PLUGINSDIR\results.ini"
!define CL_HELP_URL "${HOMEPAGE}"
!define CL_HELP_TEXT "github.com/ConformLabs/surehand-mcp"
!define CL_UNCONFIRM_SHOW un.ConfirmShow
!define CL_UNINSTFILES_STEPS un.ListSteps
!define CL_UNFINISH_SHOW un.FinishLines
!include "${__FILEDIR__}\..\..\common\conformlabs.nsh"

!define MUI_WELCOMEPAGE_TITLE "Install ${PRODUCT}"
!define MUI_WELCOMEPAGE_TEXT " "
!define MUI_FINISHPAGE_TITLE "${PRODUCT} is installed"
!define MUI_FINISHPAGE_TEXT " "
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!define UNCONFIRM_KEEP "${PRODUCT} will be removed: the server, the After Effects extension, its AI app connections and its private Node.js. Your settings (.surehand\ae\config.json), project checkpoints (.surehand\ae\checkpoints) and your other files there are kept."
!define UNCONFIRM_ALL "${PRODUCT} will be removed: the server, the After Effects extension, its AI app connections and its private Node.js. Your settings, project checkpoints and everything else in .surehand\ae are removed too."
!define MUI_UNCONFIRMPAGE_TEXT_TOP "${UNCONFIRM_KEEP}"

!insertmacro CL_PAGE_MAINTENANCE ; Setup run again on a computer that has it: update, or uninstall
!insertmacro CL_PAGE_WELCOME
Page custom AppsCreate AppsLeave ; Choose AI apps
!insertmacro CL_PAGE_INSTFILES
!insertmacro CL_PAGE_FINISH

!insertmacro CL_UNPAGE_CONFIRM
!insertmacro CL_UNPAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "${PRODUCT} is uninstalled"
!define MUI_FINISHPAGE_TEXT " "
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!insertmacro CL_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

; ---------- the AI apps (installer/ai-apps.json, through AI_APPS_NSH) ----------
!macro _APP_VARS N ID NAME
  Var App${N}.Box     ; its check box on "Choose AI apps"
  Var App${N}.Found   ; 1: the app is on this computer (surehand-ae clients --json "installed")
  Var App${N}.Was     ; 1: it is connected now ("configured")
  Var App${N}.Chosen  ; 1: ticked ("" until the page was shown: a silent Setup connects every app it finds)
!macroend
!insertmacro AI_APPS_FOR_EACH _APP_VARS
Var TunnelBox
Var Tunnel     ; 1: "Set up ChatGPT on the web" ticked (download cloudflared)
Var Detected   ; 1 once the app list was read
Var RtNode     ; the Node.js ExtractRuntime found or unpacked
Var UnAll      ; uninstaller: 1 with /ALL (remove the settings and checkpoints too)
Var UnAE       ; uninstaller: 1 when After Effects was open
Var UnNodeKept ; uninstaller: 1 when the shared Node.js stayed for another Surehand app

; $0 = process image name -> $0 = 1 if running, else 0
!macro IsRunning EXE
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /c "$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${EXE}" /NH | "$SYSDIR\find.exe" /I "${EXE}"'
  Pop $0
  Pop $1
  ${If} $0 == 0
    StrCpy $0 1
  ${Else}
    StrCpy $0 0
  ${EndIf}
!macroend

Function .onInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "${PRODUCT} needs Windows 10 or later." /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "${PRODUCT} needs 64-bit Windows." /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
  StrCpy $Tunnel 0
  !insertmacro CL_ONINIT ; fonts; is it installed already? (the maintenance page; a silent Setup ignores it)
FunctionEnd

Function .onGUIEnd
  !insertmacro CL_ONGUIEND
FunctionEnd

; This version's server and cl-run.cjs in $PLUGINSDIR\rt, and a Node.js to run them -> $RtNode: the installed one
; when there is one (quick: no 80 MB to unpack and have scanned), else this version's (also in $PLUGINSDIR\rt).
; To read the AI apps before installing, and for the uninstall's clean-up. Extracted once.
Function ExtractRuntime
  InitPluginsDir
  ${IfNot} ${FileExists} "$PLUGINSDIR\rt\surehand-ae.mjs"
    SetOutPath "$PLUGINSDIR\rt"
    File "/oname=surehand-ae.mjs" "${SERVER_MJS}"
    File "/oname=cl-run.cjs" "${CL_RUN}"
    SetOutPath "$TEMP"
  ${EndIf}
  StrCpy $RtNode "${NODE_DIR}\node.exe"
  ${IfNot} ${FileExists} "$RtNode"
    StrCpy $RtNode "$PLUGINSDIR\rt\node.exe"
    ${IfNot} ${FileExists} "$RtNode"
      SetOutPath "$PLUGINSDIR\rt"
      File "/oname=node.exe" "${NODE_EXE}"
      SetOutPath "$TEMP"
    ${EndIf}
  ${EndIf}
FunctionEnd

; the AI apps on this computer: `surehand-ae clients --json` (read only) as $PLUGINSDIR\clients.ini
Function DetectApps
  ${If} $Detected == 1
    Return
  ${EndIf}
  StrCpy $Detected 1
  Call ExtractRuntime
  nsExec::Exec '"$RtNode" "$PLUGINSDIR\rt\cl-run.cjs" --ini "$PLUGINSDIR\clients.ini" -- "$PLUGINSDIR\rt\surehand-ae.mjs" clients --json'
  Pop $0
FunctionEnd

; $0 = app id -> $1 found (1/0), $2 connected (1/0). Not in the list (the detection failed): found, not connected.
Function FindClient
  Push $3
  Push $4
  Push $5
  StrCpy $1 1
  StrCpy $2 0
  ReadINIStr $3 "$PLUGINSDIR\clients.ini" "clients" "count"
  ${If} $3 != ""
    StrCpy $4 0
    ${DoWhile} $4 < $3
      ReadINIStr $5 "$PLUGINSDIR\clients.ini" "clients.$4" "id"
      ${If} $5 == $0
        ReadINIStr $1 "$PLUGINSDIR\clients.ini" "clients.$4" "installed"
        ReadINIStr $2 "$PLUGINSDIR\clients.ini" "clients.$4" "configured"
        ${Break}
      ${EndIf}
      IntOp $4 $4 + 1
    ${Loop}
  ${EndIf}
  ${IfThen} $1 != 1 ${|} StrCpy $1 0 ${|}
  ${IfThen} $2 != 1 ${|} StrCpy $2 0 ${|}
  Pop $5
  Pop $4
  Pop $3
FunctionEnd

; ---------- Choose AI apps ----------
!macro _APP_ROW N ID NAME
  StrCpy $0 "${ID}"
  Call FindClient
  StrCpy $App${N}.Found $1
  StrCpy $App${N}.Was $2
  StrCpy $R1 "${NAME}"
  StrCpy $R2 ""
  StrCpy $R3 1
  ${If} $1 != 1
    ; not found: the box disabled, the name muted with a note (the labels stay enabled)
    StrCpy $R2 "Not found on this PC. Install it, then run Setup again."
    StrCpy $R3 0
  ${EndIf}
  GetFunctionAddress $R4 ToggleApp${N}
  Call cl.CheckRow
  StrCpy $App${N}.Box $R5
  ; ticked: the user's own choice (back from the next page), else the current connections when updating, else
  ; every app found
  ${If} $App${N}.Chosen == ""
    ${If} $cl.Installed == 1
      StrCpy $App${N}.Chosen $2
    ${Else}
      StrCpy $App${N}.Chosen $1
    ${EndIf}
  ${EndIf}
  ${If} $App${N}.Chosen == 1
  ${AndIf} $1 == 1
    ${NSD_Check} $R5
  ${EndIf}
  IntOp $R0 $R0 + $R6
!macroend

!macro _APP_TOGGLE N ID NAME
  Function ToggleApp${N}
    Pop $0
    ${NSD_GetState} $App${N}.Box $0
    ${If} $0 == ${BST_CHECKED}
      ${NSD_Uncheck} $App${N}.Box
    ${Else}
      ${NSD_Check} $App${N}.Box
    ${EndIf}
  FunctionEnd
!macroend
!insertmacro AI_APPS_FOR_EACH _APP_TOGGLE

Function ToggleTunnel
  Pop $0
  ${NSD_GetState} $TunnelBox $0
  ${If} $0 == ${BST_CHECKED}
    ${NSD_Uncheck} $TunnelBox
  ${Else}
    ${NSD_Check} $TunnelBox
  ${EndIf}
FunctionEnd

; Choose AI apps. The apps are read before the page is built (controls made later, from a timer, lost their colours
; and fonts on Windows 11), but visibly: the header already says "Choose AI apps", the previous page is hidden and a
; note says what is happening, Next is disabled, and clicks and keys made meanwhile are dropped, so none goes on to
; the install. The installed Node.js reads them when there is one (about a second).
Function AppsCreate
  !insertmacro MUI_HEADER_TEXT "Choose AI apps" "Surehand connects the apps you tick. You can change this later in the panel."
  ${If} $Detected != 1
    Call DetectAppsVisibly
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
  Call AppsRows
  Call cl.AppPageShow
  StrCpy $0 "&Install"
  ${If} $cl.Installed == 1
    StrCpy $0 $cl.ActionButton ; Update / Reinstall
  ${EndIf}
  Call cl.SetMainButton
  nsDialogs::Show
FunctionEnd

Function DetectAppsVisibly
  Call cl.HideLines ; MUI showed the separator and the branding line again when it left the welcome page
  ; the previous page out of the way, a note where this page will be
  FindWindow $1 "#32770" "" $HWNDPARENT
  ${If} $1 <> 0
    ShowWindow $1 ${SW_HIDE}
  ${EndIf}
  GetDlgItem $1 $HWNDPARENT 1018 ; MUI's placeholder for the inner page
  System::Call "*(i,i,i,i)p.r2"
  System::Call "user32::GetWindowRect(p r1, p r2)"
  System::Call "user32::MapWindowPoints(p 0, p $HWNDPARENT, p r2, i 2)"
  System::Call "*$2(i.r3, i.r4, i.r5, i)"
  System::Free $2
  IntOp $5 $5 - $3
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "Looking for the AI apps on this PC…", i 0x50000000, i r3, i r4, i r5, i 24, p $HWNDPARENT, p 0, p 0, p 0) p.r6'
  SetCtlColors $6 "${CL_MUTED}" "${CL_PAPER}"
  SendMessage $HWNDPARENT ${WM_GETFONT} 0 0 $1
  SendMessage $6 ${WM_SETFONT} $1 0
  GetDlgItem $7 $HWNDPARENT 1
  EnableWindow $7 0
  Call cl.SyncMainButton
  System::Call "user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x185)" ; RDW_INVALIDATE|ERASE|ALLCHILDREN|UPDATENOW
  Call DetectApps
  System::Call "user32::DestroyWindow(p r6)"
  ; drop the clicks and keys made while Setup was busy
  System::Call "*(&i48)p.r2"
  ${Do}
    System::Call "user32::PeekMessageW(p r2, p 0, i 0x100, i 0x109, i 1) i.r1" ; keyboard
    ${IfThen} $1 = 0 ${|} System::Call "user32::PeekMessageW(p r2, p 0, i 0x200, i 0x20E, i 1) i.r1" ${|} ; mouse
    ${IfThen} $1 = 0 ${|} System::Call "user32::PeekMessageW(p r2, p 0, i 0xA0, i 0xAD, i 1) i.r1" ${|} ; mouse on frames
    ${If} $1 = 0
      ${Break}
    ${EndIf}
  ${Loop}
  System::Free $2
  EnableWindow $7 1
FunctionEnd

; the rows, on the page being shown
Function AppsRows
  !insertmacro CL_SECTION_LABEL 0 "AI APPS"
  StrCpy $R0 11 ; the next row's top (dialog units)
  !insertmacro AI_APPS_FOR_EACH _APP_ROW
  IntOp $R0 $R0 + 4
  !insertmacro CL_SECTION_LABEL $R0u "OPTIONAL"
  IntOp $R0 $R0 + 10
  StrCpy $R1 "${AI_WEB_TITLE}"
  StrCpy $R2 "Downloads Cloudflare's cloudflared (about 55 MB) for the secure link ChatGPT uses."
  StrCpy $R3 1
  GetFunctionAddress $R4 ToggleTunnel
  Call cl.CheckRow
  StrCpy $TunnelBox $R5
  ${If} $Tunnel == 1
    ${NSD_Check} $TunnelBox
  ${EndIf}
  IntOp $R0 $R0 + $R6
  !insertmacro CL_RULE $R0u
FunctionEnd

!macro _APP_LEAVE N ID NAME
  ${NSD_GetState} $App${N}.Box $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $App${N}.Chosen 1
  ${Else}
    StrCpy $App${N}.Chosen 0
  ${EndIf}
!macroend

Function AppsLeave
  ${If} $Detected != 1
    Abort ; the apps are still being read
  ${EndIf}
  !insertmacro AI_APPS_FOR_EACH _APP_LEAVE
  ${NSD_GetState} $TunnelBox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Tunnel 1
  ${Else}
    StrCpy $Tunnel 0
  ${EndIf}
FunctionEnd

; ---------- the progress page's steps (the install section runs them in this order) ----------
!macro _APP_STEP_NAME N ID NAME
  ${If} $App${N}.Chosen == 1
  ${AndIf} $App${N}.Found == 1
    Push "Connecting ${NAME}"
    Call cl.StepAdd
  ${ElseIf} $App${N}.Chosen == 0
  ${AndIf} $App${N}.Was == 1
  ${AndIf} $App${N}.Found == 1
    Push "Disconnecting ${NAME}"
    Call cl.StepAdd
  ${EndIf}
!macroend

Function ListSteps
  Push "Installing ${PRODUCT}"
  Call cl.StepAdd
  Push "Setting up After Effects"
  Call cl.StepAdd
  !insertmacro AI_APPS_FOR_EACH _APP_STEP_NAME
  ${If} $Tunnel == 1
    Push "Downloading cloudflared"
    Call cl.StepAdd
  ${EndIf}
FunctionEnd

; A Claude Desktop that is open rewrites its settings from memory when it quits and can drop a new connection.
Function CheckClaudeDesktop
  !insertmacro IsRunning "claude.exe"
  ${If} $0 == 1
    MessageBox MB_OK|MB_ICONINFORMATION "Claude Desktop is open.$\r$\n$\r$\nQuit Claude Desktop now (tray icon > Quit), then click OK. Otherwise it can undo the new connection when it quits." /SD IDOK
  ${EndIf}
FunctionEnd

; $1 = the server's arguments: runs it with the installed Node.js through cl-run.cjs (no console, readable output
; in "Show details") -> $0 exit code
Function RunServer
  nsExec::ExecToLog '"${NODE_DIR}\node.exe" "$PLUGINSDIR\cl-run.cjs" -- "${SERVER}" $1'
  Pop $0
FunctionEnd

; $0 = exit code -> the current step DONE (0) or FAILED
Function EndStep
  ${If} $0 == 0
    Push "done"
  ${Else}
    Push "failed"
  ${EndIf}
  Call cl.StepEnd
FunctionEnd

!macro _APP_STEP_RUN N ID NAME
  ${If} $App${N}.Chosen == 1
  ${AndIf} $App${N}.Found == 1
    Call cl.StepStart
    !if "${ID}" == "claude-desktop"
      Call CheckClaudeDesktop
    !endif
    DetailPrint "Connecting ${NAME}"
    StrCpy $1 "install --connect-only --clients ${ID}"
    Call RunServer
    Call EndStep
  ${ElseIf} $App${N}.Chosen == 0
  ${AndIf} $App${N}.Was == 1
  ${AndIf} $App${N}.Found == 1
    Call cl.StepStart
    DetailPrint "Disconnecting ${NAME}"
    StrCpy $1 "install --connect-only --disconnect ${ID}"
    Call RunServer
    Call EndStep
  ${EndIf}
!macroend

Section "Install"
  SetShellVarContext current
  SetDetailsPrint both

  ; --- 1. Installing Surehand MCP: the private Node.js and the server ---
  Call cl.StepStart
  DetailPrint "Installing Node.js ${NODE_VERSION} to ${NODE_DIR}"
  CreateDirectory "${NODE_DIR}"
  Delete "${NODE_DIR}\node.exe.old-*"
  ${If} ${FileExists} "${NODE_DIR}\node.exe"
    Delete "${NODE_DIR}\node.exe"
    ${If} ${FileExists} "${NODE_DIR}\node.exe"
      ; in use by an AI app that is running the server: a running .exe can be renamed, not replaced
      System::Call "kernel32::GetTickCount()i.r2"
      ClearErrors
      Rename "${NODE_DIR}\node.exe" "${NODE_DIR}\node.exe.old-$2"
      ${If} ${Errors}
        Push "failed"
        Call cl.StepEnd
        MessageBox MB_ICONSTOP "Could not replace ${NODE_DIR}\node.exe (it is in use). Quit your AI apps and run Setup again." /SD IDOK
        SetErrorLevel 2
        Abort "Node.js is in use."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  SetOutPath "${NODE_DIR}"
  File "/oname=node.exe" "${NODE_EXE}"
  DetailPrint "Installing the server to ${SERVER_DIR}"
  SetOutPath "${SERVER_DIR}"
  File "/oname=surehand-ae.mjs" "${SERVER_MJS}"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=cl-run.cjs" "${CL_RUN}"
  SetOutPath "$TEMP"
  Push "done"
  Call cl.StepEnd

  ; --- 2. Setting up After Effects: `surehand-ae install` (extension, config; a silent Setup also connects every
  ;        AI app it finds) ---
  Call cl.StepStart
  DetailPrint "Running: node surehand-ae.mjs install"
  StrCpy $1 "install --clients none"
  ${If} ${Silent}
  ${OrIf} $App1.Chosen == ""
    StrCpy $1 "install"
  ${EndIf}
  Call RunServer
  ${If} $0 != 0
    Push "failed"
    Call cl.StepEnd
    DetailPrint "surehand-ae install failed (exit code $0)."
    MessageBox MB_ICONSTOP "${PRODUCT} could not finish installing (exit code $0). Click Show details for the reason." /SD IDOK
    SetErrorLevel 2
    Abort "Installation failed."
  ${EndIf}
  Push "done"
  Call cl.StepEnd

  ; --- 3. each AI app ticked (or no longer ticked when updating), then cloudflared ---
  !insertmacro AI_APPS_FOR_EACH _APP_STEP_RUN
  ${If} $Tunnel == 1
    Call cl.StepStart
    DetailPrint "Downloading cloudflared (ChatGPT on the web)"
    StrCpy $1 "install --connect-only --tunnel"
    Call RunServer
    Call EndStep
  ${EndIf}

  ; --- what happened, for the finish page (the server's results as an INI file NSIS can read) ---
  nsExec::Exec '"${NODE_DIR}\node.exe" "$PLUGINSDIR\cl-run.cjs" --ini "${CL_RESULTS_INI}" --json-file "${RESULT_JSON}"'
  Pop $0

  ; --- uninstaller + Add/Remove Programs (per user) ---
  SetOutPath "$INSTDIR"
  File "/oname=surehand-mcp.ico" "${ICON}"
  WriteUninstaller "$INSTDIR\${UNINST_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\surehand-mcp.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\${UNINST_EXE}"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINST_EXE}" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "${HOMEPAGE}"
  WriteRegStr HKCU "${UNINST_KEY}" "HelpLink" "${HOMEPAGE}"
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" ${ESTIMATED_KB}
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  SetOutPath "$TEMP"
  SetAutoClose true ; on to the finish page, which says what happened
SectionEnd

; "Also remove my settings and checkpoints" with an uninstaller from before it knew /ALL (1.4.0-beta.1): what it
; kept is removed by this version's server (`uninstall --all`, run from $PLUGINSDIR).
Function AfterUninstall
  ${If} $cl.RemoveAll == 1
  ${AndIf} ${FileExists} "${APPDIR}\*.*"
    Call ExtractRuntime
    nsExec::Exec '"$RtNode" "$PLUGINSDIR\rt\cl-run.cjs" -- "$PLUGINSDIR\rt\surehand-ae.mjs" uninstall --all'
    Pop $0
  ${EndIf}
FunctionEnd

; ---------- uninstaller ----------
; /ALL (the maintenance page's "Also remove my settings and checkpoints"): `uninstall --all`, which removes
; everything in .surehand\ae. Otherwise it keeps the user's data: .surehand\ae\config.json (settings, token) and
; .surehand\ae\checkpoints (project safety copies), and any other files there.
Function un.onInit
  StrCpy $UnAll 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/ALL" $1
  ${IfNot} ${Errors}
    StrCpy $UnAll 1
  ${EndIf}
  !insertmacro CL_UNONINIT
FunctionEnd

Function un.onGUIEnd
  !insertmacro CL_ONGUIEND
FunctionEnd

; the confirmation says what /ALL removes
Function un.ConfirmShow
  ${If} $UnAll == 1
    FindWindow $1 "#32770" "" $HWNDPARENT
    GetDlgItem $0 $1 1006
    SendMessage $0 ${WM_SETTEXT} 0 "STR:${UNCONFIRM_ALL}"
  ${EndIf}
FunctionEnd

; the progress page's steps (the section runs them in this order)
Function un.ListSteps
  ${If} $UnAll == 1
    Push "Removing ${PRODUCT}, your settings and checkpoints"
  ${Else}
    Push "Removing the server, the After Effects extension and the AI app connections"
  ${EndIf}
  Call un.cl.StepAdd
  Push "Removing Node.js"
  Call un.cl.StepAdd
  Push "Removing the uninstaller"
  Call un.cl.StepAdd
FunctionEnd

; the finish page's lines under its title (what was kept, what to do)
Function un.FinishLines
  ${If} $UnAll == 1
    StrCpy $1 "Its settings, project checkpoints and everything else in .surehand\ae were removed too."
  ${Else}
    StrCpy $1 "Your settings and project checkpoints are kept in .surehand\ae, for when you install it again."
  ${EndIf}
  ${NSD_CreateLabel} 124u 38u 196u 28u "$1"
  Pop $0
  SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
  ${If} $UnNodeKept == 1
    ${NSD_CreateLabel} 124u 70u 196u 18u "Node.js stays in .surehand\node: another Surehand app uses it."
    Pop $0
    SetCtlColors $0 "${CL_MUTED}" "${CL_PAPER}"
  ${EndIf}
  ${If} $UnAE == 1
    ${NSD_CreateLabel} 124u 94u 196u 18u "Restart After Effects (it is open) to finish removing ${PRODUCT}."
    Pop $0
    SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
  ${EndIf}
FunctionEnd

; It removes the server, the After Effects extension, the AI app entries and cloudflared if Surehand downloaded it
; (all done by `surehand-ae uninstall`, which also leaves any other files in .surehand\ae alone unless --all, and
; removes what 1.3's .aemcp kept for the move), the private Node.js and the uninstaller.
Section "Uninstall"
  SetShellVarContext current
  SetDetailsPrint both

  !insertmacro IsRunning "AfterFX.exe"
  StrCpy $UnAE $0
  StrCpy $UnNodeKept 0

  ; --- 1. the server's own uninstall: the extension, the AI app connections, its files (all of them with /ALL) ---
  Call un.cl.StepStart
  StrCpy $5 0
  ${If} ${FileExists} "${NODE_DIR}\node.exe"
  ${AndIf} ${FileExists} "${SERVER}"
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "/oname=cl-run.cjs" "${CL_RUN}"
    StrCpy $1 "--keep-config"
    ${If} $UnAll == 1
      StrCpy $1 "--all"
    ${EndIf}
    nsExec::ExecToLog '"${NODE_DIR}\node.exe" "$PLUGINSDIR\cl-run.cjs" -- "${SERVER}" uninstall $1'
    Pop $0
    SetOutPath "$TEMP"
    ${If} $0 != 0
      DetailPrint "surehand-ae uninstall reported a problem (exit code $0)."
      StrCpy $5 1
    ${EndIf}
  ${Else}
    ; no Node or server left (e.g. removed by hand): remove the extension; AI app settings are left as they are
    DetailPrint "The ${PRODUCT} server was not found; removing the After Effects extension only."
    RMDir /r "${CEP_EXT}"
    Delete "${SERVER}"
    RMDir "${SERVER_DIR}"
  ${EndIf}
  ${If} $5 == 0
    Push "done"
  ${Else}
    Push "failed"
  ${EndIf}
  Call un.cl.StepEnd

  ; --- 2. the private Node.js is shared by the Surehand apps: removed only when no other one (.surehand\<app>)
  ; is installed (an AI app still running the server can keep node.exe in use). node, ffmpeg and bin are shared
  ; folders, not apps.
  StrCpy $1 0
  FindFirst $2 $3 "${SUREHAND}\*.*"
  ${DoWhile} $3 != ""
    ${If} ${FileExists} "${SUREHAND}\$3\*.*"
    ${AndIf} $3 != "."
    ${AndIf} $3 != ".."
    ${AndIf} $3 != "ae"
    ${AndIf} $3 != "node"
    ${AndIf} $3 != "ffmpeg"
    ${AndIf} $3 != "bin"
      StrCpy $4 $3 1
      ${If} $4 != "."
        StrCpy $1 1
      ${EndIf}
    ${EndIf}
    FindNext $2 $3
  ${Loop}
  FindClose $2
  Call un.cl.StepStart
  StrCpy $5 "done"
  ${If} $1 == 1
    DetailPrint "Kept ${NODE_DIR}: another Surehand app uses it."
    StrCpy $UnNodeKept 1
  ${Else}
    RMDir /r "${NODE_DIR}"
    ${If} ${FileExists} "${NODE_DIR}\*.*"
      DetailPrint "Some of ${NODE_DIR} is in use; quit your AI apps and delete it by hand."
      StrCpy $5 "failed"
    ${EndIf}
  ${EndIf}
  Push $5
  Call un.cl.StepEnd
  RMDir "${APPDIR}" ; only if empty (config.json and checkpoints are kept)
  RMDir "${SUREHAND}"
  RMDir "${LEGACY}"

  ; --- 3. the uninstaller and the Add/Remove Programs entry ---
  Call un.cl.StepStart
  DeleteRegKey HKCU "${UNINST_KEY}"
  Delete "$INSTDIR\surehand-mcp.ico"
  Delete "$INSTDIR\${UNINST_EXE}"
  RMDir "$INSTDIR"
  Push "done"
  Call un.cl.StepEnd
  ; on to the finish page, which says what was kept and whether to restart After Effects
  SetAutoClose true
SectionEnd
