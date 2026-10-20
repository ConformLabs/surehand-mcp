; Conform Labs installer frame for NSIS (Modern UI 2): the look every Conform Labs app's Windows installer shares.
; The app brings its own logo (bitmaps from installer/common/generate-art.mjs), accent colour, wording and payload.
;
; Define before !include (the app's .nsi):
;   CL_APP_NAME        "Surehand MCP"
;   CL_APP_VERSION     the version being installed, e.g. 1.4.0
;   CL_ACCENT          the app's accent on dark, RRGGBB (installer/app.json accent.dark without the #)
;   CL_ART             folder with the app's wizard-<w>.bmp and header-<w>.bmp (generate-art.mjs)
;   CL_UNINST_KEY      its HKCU uninstall key (Software\Microsoft\Windows\CurrentVersion\Uninstall\<id>)
;   CL_UNINST_EXE      its uninstaller's file name, written to $INSTDIR
;   optional: CL_KEEP_NOTE (what reinstalling keeps), CL_UNINSTALL_NOTE (what uninstalling removes and keeps)
;   MUI interface settings (MUI_ICON, MUI_UNICON...) also go before the !include: it inserts MUI_INTERFACE.
; Then use these instead of the MUI page macros (page texts such as MUI_WELCOMEPAGE_TITLE go before each), and call
; CL_ONINIT from .onInit:
;   !insertmacro CL_PAGE_MAINTENANCE   ; only when the app is installed and Setup is not silent
;   !insertmacro CL_PAGE_WELCOME       ; skipped when the maintenance page is shown
;   !insertmacro CL_PAGE_INSTFILES
;   !insertmacro CL_PAGE_FINISH
;   !insertmacro CL_UNPAGE_CONFIRM
;   !insertmacro CL_UNPAGE_INSTFILES
;   !insertmacro MUI_LANGUAGE "English"
;
; Maintenance page: when the app's uninstall key names an install folder that has its uninstaller, Setup opens on a
; page offering "Update to X" / "Reinstall X" / "Install X (you have Y)", or "Uninstall". Uninstall runs the app's own
; uninstaller (a copy in $PLUGINSDIR with _?=<install folder>, the standard NSIS way) and waits for it, so it does
; exactly what Windows Settings > Apps > Uninstall does. A silent Setup (/S) never shows pages: it installs or upgrades.

!include MUI2.nsh
!include LogicLib.nsh
!include nsDialogs.nsh
!include WordFunc.nsh

!macro _CL_REQUIRE NAME
  !ifndef ${NAME}
    !error "conformlabs.nsh: define ${NAME} before including it"
  !endif
!macroend
!insertmacro _CL_REQUIRE CL_APP_NAME
!insertmacro _CL_REQUIRE CL_APP_VERSION
!insertmacro _CL_REQUIRE CL_ACCENT
!insertmacro _CL_REQUIRE CL_ART
!insertmacro _CL_REQUIRE CL_UNINST_KEY
!insertmacro _CL_REQUIRE CL_UNINST_EXE
!define /ifndef CL_KEEP_NOTE "Your settings are kept."
!define /ifndef CL_UNINSTALL_NOTE "Removes ${CL_APP_NAME} from this Windows account. Your settings are kept."

; ---------- colours (installer/common/frame.mjs COLORS) ----------
!define CL_INK "14161A"
!define CL_PANEL "17191D"
!define CL_HEADER "101215"
!define CL_TEXT "F2EFE8"
!define CL_TEXT2 "D8D6D0"
!define CL_TEXT3 "A9A69F"
!define CL_LINE "2A2D33"
; COLORREF (0x00BBGGRR) for SendMessage
!define /math _CL_R 0x${CL_ACCENT} >> 16
!define /math _CL_G 0x${CL_ACCENT} >> 8
!define /math _CL_G2 ${_CL_G} & 0xFF
!define /math _CL_B 0x${CL_ACCENT} & 0xFF
!define /math _CL_B2 ${_CL_B} << 16
!define /math _CL_G3 ${_CL_G2} << 8
!define /math _CL_BG ${_CL_B2} | ${_CL_G3}
!define /math CL_ACCENT_COLORREF ${_CL_BG} | ${_CL_R}
!define CL_INK_COLORREF 0x1A1614

; Windows 10 1809+ / 11 draw push buttons, scroll bars and the details list dark with the system's dark theme
; class. Unsupported systems fall back to the normal look. Define CL_NO_DARK_CONTROLS to turn it off.

; ---------- installer attributes ----------
SetFont "Segoe UI" 9
BrandingText "A Conform Labs product"
ShowInstDetails show
ShowUninstDetails show

!define MUI_BGCOLOR "${CL_PANEL}"
!define MUI_TEXTCOLOR "${CL_TEXT}"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${CL_ART}\header-150.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "${CL_ART}\header-150.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${CL_ART}\wizard-164.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${CL_ART}\wizard-164.bmp"
!define MUI_INSTFILESPAGE_COLORS "${CL_TEXT2} ${CL_INK}"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
!define MUI_FINISHPAGE_LINK_COLOR "${CL_ACCENT}"
!define MUI_ABORTWARNING
!define MUI_CUSTOMFUNCTION_GUIINIT cl.GUIInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.cl.GUIInit
; the interface (and its $mui.* variables) now, so that the frame's functions below can use them
!insertmacro MUI_INTERFACE

Var cl.Installed         ; 1 when the maintenance page applies
Var cl.InstalledVersion  ; DisplayVersion of the installed copy
Var cl.InstalledDir      ; its InstallLocation (where its uninstaller is)
Var cl.Art               ; cl.PickArt: in = kind (wizard|header), out = bitmap file
Var cl.ArtHwnd           ; cl.PickArt: the image control
Var cl.Dialog
Var cl.RadioInstall
Var cl.RadioUninstall
Var cl.ActionText        ; "Update to 1.4.0", "Reinstall 1.4.0", "Install 1.4.0 (you have 1.5.0)"
Var cl.ActionButton      ; "Update", "Reinstall", "Install"
Var cl.ActionNote
Var cl.TitleFont

; ---------- shared functions (installer and uninstaller) ----------
!macro _CL_SHARED_FUNCTIONS UN
; The welcome/finish and header images come in the sizes generate-art.mjs renders (frame.mjs WIZARD_SIZES,
; HEADER_SIZES); load the one nearest the control's real size so the logo is not blurred by stretching.
Function ${UN}cl.PickArt
  Push $0
  Push $1
  Push $2
  System::Call "*(i,i,i,i)p.r2"
  System::Call "user32::GetClientRect(p $cl.ArtHwnd, p r2)"
  System::Call "*$2(i,i,i.r0,i)"
  System::Free $2
  ${If} $cl.Art == "wizard"
    StrCpy $1 164
    ${IfThen} $0 > 177 ${|} StrCpy $1 191 ${|}
    ${IfThen} $0 > 214 ${|} StrCpy $1 238 ${|}
    ${IfThen} $0 > 262 ${|} StrCpy $1 286 ${|}
    ${IfThen} $0 > 310 ${|} StrCpy $1 334 ${|}
    ${IfThen} $0 > 358 ${|} StrCpy $1 382 ${|}
  ${Else}
    StrCpy $1 150
    ${IfThen} $0 > 162 ${|} StrCpy $1 175 ${|}
    ${IfThen} $0 > 197 ${|} StrCpy $1 219 ${|}
    ${IfThen} $0 > 240 ${|} StrCpy $1 262 ${|}
    ${IfThen} $0 > 284 ${|} StrCpy $1 306 ${|}
    ${IfThen} $0 > 328 ${|} StrCpy $1 350 ${|}
  ${EndIf}
  StrCpy $cl.Art "$PLUGINSDIR\cl\$cl.Art-$1.bmp"
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; $0 = control: the system's dark theme class (push buttons, list views, scroll bars)
Function ${UN}cl.DarkControl
  !ifndef CL_NO_DARK_CONTROLS
    System::Call "uxtheme::SetWindowTheme(p r0, w 'DarkMode_Explorer', p 0)"
  !endif
FunctionEnd

; $0 = an etched line (SS_ETCHEDHORZ): redraw it as a flat line in the frame's line colour
Function ${UN}cl.FlatLine
  ${If} $0 == 0
    Return
  ${EndIf}
  System::Call "user32::GetWindowLong(p r0, i ${GWL_STYLE}) i.r1"
  IntOp $1 $1 & 0xFFFFFFE0 ; SS_TYPEMASK off: a plain static, filled with its background colour
  System::Call "user32::SetWindowLong(p r0, i ${GWL_STYLE}, i r1)"
  SetCtlColors $0 "" "${CL_LINE}"
FunctionEnd

; the outer window: header, branding line, buttons
Function ${UN}cl.GUIInit
  Push $0
  Push $1
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\cl"
  !if "${UN}" == ""
    File "${CL_ART}\wizard-*.bmp"
  !endif
  File "${CL_ART}\header-*.bmp"
  SetOutPath "$TEMP"

  SetCtlColors $HWNDPARENT "${CL_TEXT}" "${CL_PANEL}"
  GetDlgItem $0 $HWNDPARENT 1034 ; header background
  SetCtlColors $0 "" "${CL_HEADER}"
  GetDlgItem $0 $HWNDPARENT 1037 ; header title
  SetCtlColors $0 "${CL_TEXT}" "${CL_HEADER}"
  GetDlgItem $0 $HWNDPARENT 1038 ; header subtitle
  SetCtlColors $0 "${CL_TEXT3}" "${CL_HEADER}"
  GetDlgItem $0 $HWNDPARENT 1046 ; header image
  SetCtlColors $0 "" "${CL_HEADER}"
  StrCpy $cl.ArtHwnd $0
  StrCpy $cl.Art "header"
  Call ${UN}cl.PickArt
  SetBrandingImage /IMGID=1046 /RESIZETOFIT "$cl.Art"
  GetDlgItem $0 $HWNDPARENT 1028 ; branding text ("A Conform Labs product") and its background
  SetCtlColors $0 "${CL_TEXT3}" "${CL_PANEL}"
  GetDlgItem $0 $HWNDPARENT 1256
  SetCtlColors $0 "${CL_TEXT3}" "${CL_PANEL}"
  GetDlgItem $0 $HWNDPARENT 1036 ; line under the header
  Call ${UN}cl.FlatLine
  GetDlgItem $0 $HWNDPARENT 1035 ; line above the buttons
  Call ${UN}cl.FlatLine
  GetDlgItem $0 $HWNDPARENT 1045 ; the same line on the welcome and finish pages
  Call ${UN}cl.FlatLine
  ${For} $1 1 3 ; Next, Cancel, Back
    GetDlgItem $0 $HWNDPARENT $1
    SetCtlColors $0 "${CL_TEXT}" "${CL_PANEL}"
    Call ${UN}cl.DarkControl
  ${Next}
  Pop $1
  Pop $0
FunctionEnd

; the inner page of a built-in page (progress, uninstall confirmation): every child control
Function ${UN}cl.InnerPageShow
  Push $0
  Push $1
  Push $2
  FindWindow $1 "#32770" "" $HWNDPARENT
  SetCtlColors $1 "${CL_TEXT}" "${CL_PANEL}"
  StrCpy $0 0
  ${Do}
    FindWindow $0 "" "" $1 $0
    ${If} $0 == 0
      ${Break}
    ${EndIf}
    System::Call "user32::GetClassNameW(p r0, w .r2, i ${NSIS_MAX_STRLEN})"
    ${If} $2 == "Static"
    ${OrIf} $2 == "Edit" ; texts, the read-only "Uninstalling from" box
      SetCtlColors $0 "${CL_TEXT}" "${CL_PANEL}"
    ${ElseIf} $2 == "Button" ; "Show details"
      SetCtlColors $0 "${CL_TEXT}" "${CL_PANEL}"
      Call ${UN}cl.DarkControl
    ${ElseIf} $2 == "SysListView32" ; the details list (its colours: MUI_INSTFILESPAGE_COLORS)
      Call ${UN}cl.DarkControl
    ${ElseIf} $2 == "msctls_progress32"
      ; drawn without the visual style, so that it takes the accent colour
      System::Call "uxtheme::SetWindowTheme(p r0, w '', w '')"
      SendMessage $0 ${PBM_SETBARCOLOR} 0 ${CL_ACCENT_COLORREF}
      SendMessage $0 ${PBM_SETBKCOLOR} 0 ${CL_INK_COLORREF}
    ${EndIf}
  ${Loop}
  GetDlgItem $0 $1 1029 ; "Uninstalling from:"
  ${If} $0 <> 0
    SetCtlColors $0 "${CL_TEXT3}" "${CL_PANEL}"
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macroend


!ifndef PBM_SETBARCOLOR
  !define PBM_SETBARCOLOR 0x0409
!endif
!ifndef PBM_SETBKCOLOR
  !define PBM_SETBKCOLOR 0x2001
!endif

!insertmacro _CL_SHARED_FUNCTIONS ""
!insertmacro _CL_SHARED_FUNCTIONS "un."

; ---------- detection (call from .onInit) ----------
!macro CL_ONINIT
  Call cl.DetectInstalled
!macroend

; strips a pre-release suffix: in $0 "1.4.0-beta.1" -> $0 "1.4.0", $1 "beta.1"
Function cl.SplitVersion
  Push $2
  Push $3
  StrCpy $1 ""
  StrCpy $2 0
  ${Do}
    StrCpy $3 $0 1 $2
    ${If} $3 == ""
      ${Break}
    ${ElseIf} $3 == "-"
    ${OrIf} $3 == "+"
      IntOp $3 $2 + 1
      StrCpy $1 $0 "" $3
      StrCpy $0 $0 $2
      ${Break}
    ${EndIf}
    IntOp $2 $2 + 1
  ${Loop}
  Pop $3
  Pop $2
FunctionEnd

Function cl.DetectInstalled
  StrCpy $cl.Installed 0
  ReadRegStr $cl.InstalledVersion HKCU "${CL_UNINST_KEY}" "DisplayVersion"
  ReadRegStr $cl.InstalledDir HKCU "${CL_UNINST_KEY}" "InstallLocation"
  ${If} $cl.InstalledDir != ""
  ${AndIf} ${FileExists} "$cl.InstalledDir\${CL_UNINST_EXE}"
    StrCpy $cl.Installed 1
  ${EndIf}
  ${If} $cl.InstalledVersion == ""
    StrCpy $cl.InstalledVersion "?"
  ${EndIf}

  ; what installing this copy means: Update / Reinstall / Install (you have a newer one)
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $0 "${CL_APP_VERSION}"
  Call cl.SplitVersion
  StrCpy $2 $0 ; new core
  StrCpy $3 $1 ; new pre-release
  StrCpy $0 $cl.InstalledVersion
  Call cl.SplitVersion ; $0 installed core, $1 installed pre-release
  ${VersionCompare} $2 $0 $4 ; 0 same, 1 this one is newer, 2 the installed one is newer
  ${If} $cl.InstalledVersion == "${CL_APP_VERSION}"
    StrCpy $4 "same"
  ${ElseIf} $cl.InstalledVersion == "?"
    StrCpy $4 "other"
  ${ElseIf} $4 == 1
    StrCpy $4 "newer"
  ${ElseIf} $4 == 2
    StrCpy $4 "older"
  ${ElseIf} $1 != ""
  ${AndIf} $3 == ""
    StrCpy $4 "newer" ; 1.4.0 replaces 1.4.0-beta.1
  ${Else}
    StrCpy $4 "other"
  ${EndIf}
  ${Select} $4
  ${Case} "same"
    StrCpy $cl.ActionText "Reinstall ${CL_APP_VERSION}"
    StrCpy $cl.ActionButton "&Reinstall"
    StrCpy $cl.ActionNote "Installs the same version again, to repair it. ${CL_KEEP_NOTE}"
  ${Case} "newer"
    StrCpy $cl.ActionText "Update to ${CL_APP_VERSION}"
    StrCpy $cl.ActionButton "&Update"
    StrCpy $cl.ActionNote "Replaces version $cl.InstalledVersion. ${CL_KEEP_NOTE}"
  ${CaseElse}
    StrCpy $cl.ActionText "Install ${CL_APP_VERSION} (you have $cl.InstalledVersion)"
    StrCpy $cl.ActionButton "&Install"
    StrCpy $cl.ActionNote "Replaces version $cl.InstalledVersion with this one. ${CL_KEEP_NOTE}"
  ${EndSelect}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; ---------- pages ----------
!macro CL_PAGE_MAINTENANCE
  Page custom cl.MaintenanceCreate cl.MaintenanceLeave
!macroend

; one option (TOP in dialog units): a radio button with a title and a note beside it, all three clickable. The
; radio button has no text of its own because a themed radio button ignores the text colour (black on dark).
!macro _CL_OPTION TOP RADIO TITLE NOTE ONCLICK
  ${NSD_CreateRadioButton} 0 ${TOP}u 12u 12u ""
  Pop ${RADIO}
  SetCtlColors ${RADIO} "${CL_TEXT}" "${CL_PANEL}"
  ${NSD_OnClick} ${RADIO} ${ONCLICK}
  ${NSD_CreateLabel} 16u ${TOP}u 280u 12u "${TITLE}"
  Pop $0
  SetCtlColors $0 "${CL_TEXT}" "${CL_PANEL}"
  SendMessage $0 ${WM_SETFONT} $cl.TitleFont 0
  ${NSD_OnClick} $0 ${ONCLICK}
  !define /math _CL_NOTE_TOP ${TOP} + 14
  ${NSD_CreateLabel} 16u ${_CL_NOTE_TOP}u 280u 30u "${NOTE}"
  !undef _CL_NOTE_TOP
  Pop $0
  SetCtlColors $0 "${CL_TEXT3}" "${CL_PANEL}"
  ${NSD_OnClick} $0 ${ONCLICK}
!macroend

; The page for a Setup run on a computer that has the app: update / reinstall, or uninstall.
Function cl.MaintenanceCreate
  ${If} $cl.Installed != 1
  ${OrIf} ${Silent}
    Abort ; not installed (or silent): the normal install, starting at the welcome page
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "${CL_APP_NAME} is installed" "Version $cl.InstalledVersion is installed for your Windows account. Choose what Setup should do."

  nsDialogs::Create 1018
  Pop $cl.Dialog
  ${If} $cl.Dialog == error
    Abort
  ${EndIf}
  SetCtlColors $cl.Dialog "${CL_TEXT}" "${CL_PANEL}"
  CreateFont $cl.TitleFont "$(^Font)" 10 700

  !insertmacro _CL_OPTION 4 $cl.RadioInstall "$cl.ActionText" "$cl.ActionNote" cl.ChooseInstall
  ${NSD_AddStyle} $cl.RadioInstall ${WS_GROUP}
  !insertmacro _CL_OPTION 52 $cl.RadioUninstall "Uninstall" "${CL_UNINSTALL_NOTE}" cl.ChooseUninstall

  ${NSD_Check} $cl.RadioInstall
  Push $cl.RadioInstall
  Call cl.ChooseInstall
  nsDialogs::Show
FunctionEnd

Function cl.ChooseInstall
  Pop $0
  ${NSD_Check} $cl.RadioInstall
  ${NSD_Uncheck} $cl.RadioUninstall
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$cl.ActionButton"
FunctionEnd

Function cl.ChooseUninstall
  Pop $0
  ${NSD_Check} $cl.RadioUninstall
  ${NSD_Uncheck} $cl.RadioInstall
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:U&ninstall"
FunctionEnd

Function cl.MaintenanceLeave
  ${NSD_GetState} $cl.RadioUninstall $0
  ${If} $0 != ${BST_CHECKED}
    Return ; update / reinstall: on to the progress page (the welcome page is skipped)
  ${EndIf}
  ; Uninstall: run the installed uninstaller, exactly as Windows Settings > Apps does, and wait for it. A copy runs
  ; from $PLUGINSDIR with _?= so that it can delete the original and the install folder.
  InitPluginsDir
  ClearErrors
  CopyFiles /SILENT "$cl.InstalledDir\${CL_UNINST_EXE}" "$PLUGINSDIR\uninstall.exe"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Could not start the ${CL_APP_NAME} uninstaller ($cl.InstalledDir\${CL_UNINST_EXE})."
    Abort
  ${EndIf}
  HideWindow
  ClearErrors
  ExecWait '"$PLUGINSDIR\uninstall.exe" _?=$cl.InstalledDir' $0
  ${If} ${Errors}
    StrCpy $0 "error"
  ${EndIf}
  Delete "$PLUGINSDIR\uninstall.exe"
  ${If} $0 == 0
    Quit ; uninstalled; the uninstaller showed the result
  ${EndIf}
  ShowWindow $HWNDPARENT ${SW_SHOW}
  BringToFront
  ${If} $0 == "error"
    MessageBox MB_ICONSTOP "Could not start the ${CL_APP_NAME} uninstaller ($cl.InstalledDir\${CL_UNINST_EXE})."
  ${EndIf}
  Abort ; cancelled or failed: stay on this page
FunctionEnd

!macro CL_PAGE_WELCOME
  !define MUI_PAGE_CUSTOMFUNCTION_PRE cl.WelcomePre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW cl.WelcomeShow
  !insertmacro MUI_PAGE_WELCOME
  Function cl.WelcomePre
    ${If} $cl.Installed == 1
      Abort ; the maintenance page replaces the welcome page
    ${EndIf}
  FunctionEnd
  Function cl.WelcomeShow
    !insertmacro _CL_RELOAD_WIZARD $mui.WelcomePage.Image $mui.WelcomePage.Image.Bitmap
  FunctionEnd
!macroend

!macro CL_PAGE_INSTFILES
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW cl.InnerPageShow
  !insertmacro MUI_PAGE_INSTFILES
!macroend

!macro CL_PAGE_FINISH
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW cl.FinishShow
  !insertmacro MUI_PAGE_FINISH
  Function cl.FinishShow
    !insertmacro _CL_RELOAD_WIZARD $mui.FinishPage.Image $mui.FinishPage.Image.Bitmap
  FunctionEnd
!macroend

!macro CL_UNPAGE_CONFIRM
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.cl.InnerPageShow
  !insertmacro MUI_UNPAGE_CONFIRM
!macroend

!macro CL_UNPAGE_INSTFILES
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.cl.InnerPageShow
  !insertmacro MUI_UNPAGE_INSTFILES
!macroend

; replace MUI's stretched 164x314 image with the size nearest the control (MUI frees the handle after the page)
!macro _CL_RELOAD_WIZARD IMAGE HANDLE
  StrCpy $cl.ArtHwnd ${IMAGE}
  StrCpy $cl.Art "wizard"
  Call cl.PickArt
  Push ${HANDLE}
  ${NSD_SetStretchedImage} ${IMAGE} "$cl.Art" ${HANDLE}
  Exch $0
  ${NSD_FreeImage} $0
  Pop $0
!macroend
