; Conform Labs installer frame for NSIS (Modern UI 2): the look every Conform Labs app's Windows installer shares.
; The app brings its own art (bitmaps from installer/common/generate-art.mjs), accent colour, wording and payload.
;
; Define before !include (the app's .nsi):
;   CL_APP_NAME        "Surehand MCP"
;   CL_APP_VERSION     the version being installed, e.g. 1.4.0
;   CL_ACCENT          the app's accent on dark, RRGGBB (installer/app.json accent.dark without the #)
;   CL_ART             folder with the app's wizard-<w>.bmp, header-<w>.bmp and glyph-*.bmp (generate-art.mjs)
;   CL_UNINST_KEY      its HKCU uninstall key (Software\Microsoft\Windows\CurrentVersion\Uninstall\<id>)
;   CL_UNINST_EXE      its uninstaller's file name, written to $INSTDIR
;   optional:
;     CL_KEEP_NOTE         what updating keeps (the maintenance page)
;     CL_UNINSTALL_NOTE    what uninstalling removes (the maintenance page)
;     CL_UNINSTALL_ALL     the text of an "also remove my data" checkbox under Uninstall: when it is ticked, the
;                          uninstaller runs with /ALL (the app's uninstaller reads it)
;     CL_AFTER_UNINSTALL   a function Setup calls after the uninstaller finished ($cl.RemoveAll is 1 when the box
;                          was ticked): an uninstaller from an older version may not know /ALL
;     CL_WELCOME_SUB, CL_WELCOME_TEXT1 (ink), CL_WELCOME_TEXT2, CL_WELCOME_TEXT3 (muted): the welcome page
;     CL_INSTFILES_STEPS   a function that lists the progress page's steps (Push "text" / Call cl.StepAdd)
;     CL_RESULTS_INI       an INI file the finish page shows: [summary] count, [summary.<i>] kind (done|skipped|
;                          failed) and text; [next] count, 0..count-1 (the numbered next steps)
;     CL_HELP_URL, CL_HELP_TEXT   the finish page's help link
;   MUI interface settings (MUI_ICON, MUI_UNICON...) also go before the !include: it inserts MUI_INTERFACE.
; Then use these instead of the MUI page macros (page texts such as MUI_WELCOMEPAGE_TITLE go before each), and call
; CL_ONINIT from .onInit, CL_UNONINIT from un.onInit, CL_ONGUIEND from .onGUIEnd and un.onGUIEnd:
;   !insertmacro CL_PAGE_MAINTENANCE   ; only when the app is installed and Setup is not silent
;   !insertmacro CL_PAGE_WELCOME       ; skipped when the maintenance page is shown
;   (the app's own pages: header-band pages built with nsDialogs and the cl.* helpers below)
;   !insertmacro CL_PAGE_INSTFILES     ; plain steps; the raw log stays behind "Show details"
;   !insertmacro CL_PAGE_FINISH        ; the results (CL_RESULTS_INI) and the next steps
;   !insertmacro CL_UNPAGE_CONFIRM
;   !insertmacro CL_UNPAGE_INSTFILES
;   !insertmacro MUI_LANGUAGE "English"
;
; The look (the Conform Labs design system, dark): paper #14161A, paper-sunk #0D0E11 for the title bar, the sidebar
; and the header band, hairlines #2C3036, text #F2EFE8 / muted #A6A49D. The accent fills only the one main button and
; the "done" glyph. The dialog font stays Segoe UI 9; the Conform Labs fonts (Space Grotesk for titles, IBM Plex Sans
; SemiBold for names, IBM Plex Mono for labels and results) are loaded privately from $PLUGINSDIR for these labels
; only, and fall back to Segoe UI / Consolas if Windows does not load them.
;
; Maintenance page: when the app's uninstall key names an install folder that has its uninstaller, Setup opens on
; "Update or uninstall": update (on to the app's next page) or uninstall, which runs the app's own uninstaller (a copy
; in $PLUGINSDIR with _?=<install folder>, the standard NSIS way) and waits for it, so it does exactly what Windows
; Settings > Apps > Uninstall does. A silent Setup (/S) never shows pages: it installs or upgrades.

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
!define /ifndef CL_UNINSTALL_NOTE "Removes ${CL_APP_NAME} from this Windows account."
!define /ifndef CL_WELCOME_SUB ""
!define /ifndef CL_WELCOME_TEXT1 ""
!define /ifndef CL_WELCOME_TEXT2 ""
!define /ifndef CL_WELCOME_TEXT3 ""
!define CL_FONT_DIR "${__FILEDIR__}\fonts"

; ---------- colours (installer/common/frame.mjs COLORS: the design system's dark tokens) ----------
!define CL_PAPER "14161A"      ; page body
!define CL_SUNK "0D0E11"       ; title bar, sidebar, header band, results box
!define CL_RULE "2C3036"       ; hairlines
!define CL_INK "F2EFE8"        ; text
!define CL_MUTED "A6A49D"      ; secondary text
!define CL_REFUSED "FF7A6B"    ; failed
!define CL_ON_ACCENT "14161A"  ; text on the accent (the main button)
; COLORREF (0x00BBGGRR) for SendMessage / DWM
!define /math _CL_R 0x${CL_ACCENT} >> 16
!define /math _CL_G 0x${CL_ACCENT} >> 8
!define /math _CL_G2 ${_CL_G} & 0xFF
!define /math _CL_B 0x${CL_ACCENT} & 0xFF
!define /math _CL_B2 ${_CL_B} << 16
!define /math _CL_G3 ${_CL_G2} << 8
!define /math _CL_BG ${_CL_B2} | ${_CL_G3}
!define /math CL_ACCENT_COLORREF ${_CL_BG} | ${_CL_R}
!define CL_PAPER_COLORREF 0x1A1614
!define CL_SUNK_COLORREF 0x110E0D
!define CL_INK_COLORREF 0xE8EFF2

; ---------- fonts (installer/common/frame.mjs FONTS: TrueType name ID 1 and weight) ----------
!define CL_GDI_DISPLAY "Space Grotesk Light SemiBold"   ; 600
!define CL_GDI_STRONG "IBM Plex Sans SemiBold"          ; 600
!define CL_GDI_MONO "IBM Plex Mono"                     ; 400
!define CL_GDI_MONO_MEDIUM "IBM Plex Mono Medium"       ; 500
!define CL_FR_PRIVATE 0x10

; ---------- Win32 numbers (prefixed, so they never clash with WinMessages.nsh) ----------
!define CL_WS_CHILD_VISIBLE 0x50000000
!define CL_WS_CLIPSIBLINGS 0x04000000
!define CL_SS_RIGHT 0x2
!define CL_SS_CENTER_V 0x201          ; SS_CENTER | SS_CENTERIMAGE (one line, centred both ways)
!define CL_SS_BITMAP_CENTER 0x20E     ; SS_BITMAP | SS_CENTERIMAGE
!define CL_STM_SETIMAGE 0x172
!define CL_SWP_ZORDER_ONLY 0x13       ; SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
!define CL_SWP_SIZE_ONLY 0x16         ; SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
!ifndef PBM_SETBARCOLOR
  !define PBM_SETBARCOLOR 0x0409
!endif
!ifndef PBM_SETBKCOLOR
  !define PBM_SETBKCOLOR 0x2001
!endif

; Windows 10 1809+ / 11 draw push buttons, check boxes, scroll bars and the details list dark with the system's dark
; theme class. Unsupported systems fall back to the normal look. Define CL_NO_DARK_CONTROLS to turn it off.
; The main button: native push buttons can't be filled with a colour, so a label in the accent colour lies over the
; Next button and shows its text; it lets clicks through to the button (a static control without SS_NOTIFY), which
; keeps the keyboard, focus and screen readers. Define CL_NO_ACCENT_BUTTON to turn it off.

; ---------- installer attributes ----------
SetFont "Segoe UI" 9
Caption "${CL_APP_NAME} setup"
UninstallCaption "${CL_APP_NAME} uninstall"
BrandingText " "
ShowInstDetails hide
ShowUninstDetails show

!define MUI_BGCOLOR "${CL_PAPER}"
!define MUI_TEXTCOLOR "${CL_INK}"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${CL_ART}\header-150.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "${CL_ART}\header-150.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${CL_ART}\wizard-164.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${CL_ART}\wizard-164.bmp"
!define MUI_INSTFILESPAGE_COLORS "${CL_INK} ${CL_PAPER}"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
!define MUI_ABORTWARNING
!define MUI_CUSTOMFUNCTION_GUIINIT cl.GUIInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.cl.GUIInit
; the interface (and its $mui.* variables) now, so that the frame's functions below can use them
!insertmacro MUI_INTERFACE

Var cl.Installed         ; 1 when the maintenance page applies
Var cl.InstalledVersion  ; DisplayVersion of the installed copy
Var cl.InstalledDir      ; its InstallLocation (where its uninstaller is)
Var cl.Art               ; cl.PickArt: in = kind (wizard|header|glyph), out = bitmap file or size
Var cl.ArtHwnd           ; cl.PickArt: the image control
Var cl.Dialog
Var cl.RadioInstall
Var cl.RadioUninstall
Var cl.RemoveAllBox      ; the "also remove my data" check box
Var cl.RemoveAllLabel
Var cl.RemoveAll         ; 1 when it was ticked and Uninstall chosen
Var cl.ActionText        ; "Update to 1.4.0", "Reinstall 1.4.0", "Install 1.4.0 (you have 1.5.0)"
Var cl.ActionButton      ; "&Update", "&Reinstall", "&Install": the main button on the page after
Var cl.ActionNote
Var cl.FaceDisplay       ; the loaded font names (or the fallbacks)
Var cl.FaceStrong
Var cl.FaceMono
Var cl.FaceMonoMedium
Var cl.FontTitle         ; page titles (Space Grotesk 15)
Var cl.FontHead          ; the header band's title (Space Grotesk 11)
Var cl.FontStrong        ; names, option titles (IBM Plex Sans SemiBold 9)
Var cl.FontMono          ; results, status line, version (IBM Plex Mono 8)
Var cl.FontLabel         ; mono labels and status words (IBM Plex Mono Medium 7)
Var cl.Px                ; one device pixel at this scaling (1 at 100 %, 2 at 200 %)
Var cl.MainBtn           ; the accent label over the Next button
Var cl.cP                ; cl.Static: parent, x, y, w, h (dialog units), style, text, id -> cl.cOut
Var cl.cX
Var cl.cY
Var cl.cW
Var cl.cH
Var cl.cS
Var cl.cT
Var cl.cI
Var cl.cOut
Var cl.InnerDlg          ; the progress page's inner dialog (the steps live there)
Var cl.StepCount
Var cl.StepY
Var cl.StepNow           ; the step the install is at
Var cl.Status            ; the progress page's status line
Var cl.GDone             ; the step glyphs (bitmaps), loaded for this scaling
Var cl.GNow
Var cl.GFailed
Var cl.GNext
Var cl.HelpLink
Var cl.HeadRule          ; the hairline under the header band

; ---------- shared functions (installer and uninstaller) ----------
!macro _CL_SHARED_FUNCTIONS UN
; The welcome/finish and header images come in the sizes generate-art.mjs renders (frame.mjs WIZARD_SIZES,
; HEADER_SIZES, GLYPH_SIZES); load the one nearest the control's real size so it is not blurred by stretching.
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
  ${ElseIf} $cl.Art == "glyph"
    StrCpy $1 8
    ${IfThen} $0 > 8 ${|} StrCpy $1 9 ${|}
    ${IfThen} $0 > 10 ${|} StrCpy $1 11 ${|}
    ${IfThen} $0 > 12 ${|} StrCpy $1 13 ${|}
    ${IfThen} $0 > 14 ${|} StrCpy $1 15 ${|}
    ${IfThen} $0 > 16 ${|} StrCpy $1 18 ${|}
    StrCpy $cl.Art $1 ; a size: the caller picks kind and background
    Goto done
  ${Else}
    StrCpy $1 150
    ${IfThen} $0 > 162 ${|} StrCpy $1 175 ${|}
    ${IfThen} $0 > 197 ${|} StrCpy $1 219 ${|}
    ${IfThen} $0 > 240 ${|} StrCpy $1 262 ${|}
    ${IfThen} $0 > 284 ${|} StrCpy $1 306 ${|}
    ${IfThen} $0 > 328 ${|} StrCpy $1 350 ${|}
  ${EndIf}
  StrCpy $cl.Art "$PLUGINSDIR\cl\$cl.Art-$1.bmp"
  done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; $0 = control: the system's dark theme class (push buttons, check boxes, list views, scroll bars)
Function ${UN}cl.DarkControl
  !ifndef CL_NO_DARK_CONTROLS
    System::Call "uxtheme::SetWindowTheme(p r0, w 'DarkMode_Explorer', p 0)"
  !endif
FunctionEnd

; The Conform Labs fonts, for this process only (FR_PRIVATE): extracted to $PLUGINSDIR and added; a font Windows
; does not load falls back to Segoe UI (Consolas for mono). Called from .onInit / un.onInit.
Function ${UN}cl.LoadFonts
  Push $0
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\cl"
  File "${CL_FONT_DIR}\SpaceGrotesk-SemiBold.ttf"
  File "${CL_FONT_DIR}\IBMPlexSans-SemiBold.ttf"
  File "${CL_FONT_DIR}\IBMPlexMono-Regular.ttf"
  File "${CL_FONT_DIR}\IBMPlexMono-Medium.ttf"
  SetOutPath "$TEMP"
  System::Call "gdi32::AddFontResourceExW(w '$PLUGINSDIR\cl\SpaceGrotesk-SemiBold.ttf', i ${CL_FR_PRIVATE}, p 0) i.r0"
  StrCpy $cl.FaceDisplay "${CL_GDI_DISPLAY}"
  ${IfThen} $0 = 0 ${|} StrCpy $cl.FaceDisplay "Segoe UI" ${|}
  System::Call "gdi32::AddFontResourceExW(w '$PLUGINSDIR\cl\IBMPlexSans-SemiBold.ttf', i ${CL_FR_PRIVATE}, p 0) i.r0"
  StrCpy $cl.FaceStrong "${CL_GDI_STRONG}"
  ${IfThen} $0 = 0 ${|} StrCpy $cl.FaceStrong "Segoe UI" ${|}
  System::Call "gdi32::AddFontResourceExW(w '$PLUGINSDIR\cl\IBMPlexMono-Regular.ttf', i ${CL_FR_PRIVATE}, p 0) i.r0"
  StrCpy $cl.FaceMono "${CL_GDI_MONO}"
  ${IfThen} $0 = 0 ${|} StrCpy $cl.FaceMono "Consolas" ${|}
  System::Call "gdi32::AddFontResourceExW(w '$PLUGINSDIR\cl\IBMPlexMono-Medium.ttf', i ${CL_FR_PRIVATE}, p 0) i.r0"
  StrCpy $cl.FaceMonoMedium "${CL_GDI_MONO_MEDIUM}"
  ${IfThen} $0 = 0 ${|} StrCpy $cl.FaceMonoMedium "Consolas" ${|}
  Pop $0
FunctionEnd

Function ${UN}cl.UnloadFonts
  System::Call "gdi32::RemoveFontResourceExW(w '$PLUGINSDIR\cl\SpaceGrotesk-SemiBold.ttf', i ${CL_FR_PRIVATE}, p 0)"
  System::Call "gdi32::RemoveFontResourceExW(w '$PLUGINSDIR\cl\IBMPlexSans-SemiBold.ttf', i ${CL_FR_PRIVATE}, p 0)"
  System::Call "gdi32::RemoveFontResourceExW(w '$PLUGINSDIR\cl\IBMPlexMono-Regular.ttf', i ${CL_FR_PRIVATE}, p 0)"
  System::Call "gdi32::RemoveFontResourceExW(w '$PLUGINSDIR\cl\IBMPlexMono-Medium.ttf', i ${CL_FR_PRIVATE}, p 0)"
FunctionEnd

; MUI's etched separators (under the header 1036, above the buttons 1035 and 1045) draw white on the dark frame,
; and MUI shows them again on every page change: hide them on every page. The frame draws its own hairlines.
Function ${UN}cl.HideLines
  Push $0
  GetDlgItem $0 $HWNDPARENT 1036
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1045
  ShowWindow $0 ${SW_HIDE}
  Pop $0
FunctionEnd

; $0 = control: above its overlapping siblings (labels over the sidebar image)
Function ${UN}cl.BringToTop
  System::Call "user32::SetWindowPos(p r0, p 0, i 0, i 0, i 0, i 0, i ${CL_SWP_ZORDER_ONLY})"
FunctionEnd

; The accent label over the Next button follows the button: its text (without the & of the access key), and hidden
; while the button is hidden or disabled (the progress page). Call after anything changes the button.
Function ${UN}cl.SyncMainButton
  !ifndef CL_NO_ACCENT_BUTTON
    Push $0
    Push $1
    Push $2
    GetDlgItem $0 $HWNDPARENT 1
    System::Call "user32::IsWindowVisible(p r0) i.r1"
    System::Call "user32::IsWindowEnabled(p r0) i.r2"
    ${If} $1 = 0
    ${OrIf} $2 = 0
      ShowWindow $cl.MainBtn ${SW_HIDE}
    ${Else}
      System::Call "user32::GetWindowTextW(p r0, w .r1, i 256)"
      ${${UN}WordReplace} "$1" "&" "" "+" $1
      SendMessage $cl.MainBtn ${WM_SETTEXT} 0 "STR:$1"
      ShowWindow $cl.MainBtn ${SW_SHOW}
      Push $0
      StrCpy $0 $cl.MainBtn
      Call ${UN}cl.BringToTop
      Pop $0
    ${EndIf}
    Pop $2
    Pop $1
    Pop $0
  !endif
FunctionEnd

; $0 = the outer window's control id whose top edge gets a full-width hairline (the header band's bottom, the
; footer's top) -> $cl.cOut
Function ${UN}cl.OuterRule
  Push $1
  Push $2
  Push $3
  Push $4
  GetDlgItem $1 $HWNDPARENT $0
  System::Call "*(i,i,i,i)p.r2"
  System::Call "user32::GetWindowRect(p r1, p r2)"
  System::Call "user32::MapWindowPoints(p 0, p $HWNDPARENT, p r2, i 2)"
  System::Call "*$2(i,i.r3,i,i)"
  System::Call "user32::GetClientRect(p $HWNDPARENT, p r2)"
  System::Call "*$2(i,i,i.r4,i)"
  System::Free $2
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i ${CL_WS_CHILD_VISIBLE}, i 0, i r3, i r4, i $cl.Px, p $HWNDPARENT, p 0, p 0, p 0) p.r1'
  SetCtlColors $1 "" "${CL_RULE}"
  StrCpy $cl.cOut $1
  Pop $4
  Pop $3
  Pop $2
  Pop $1
FunctionEnd

; the outer window: title bar, header band, buttons, fonts, the accent button
Function ${UN}cl.GUIInit
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\cl"
  !if "${UN}" == ""
    File "${CL_ART}\wizard-*.bmp"
    File "${CL_ART}\glyph-*.bmp"
  !endif
  File "${CL_ART}\header-*.bmp"
  SetOutPath "$TEMP"

  ; one device pixel (hairlines)
  StrCpy $0 96
  System::Call "user32::GetDpiForWindow(p $HWNDPARENT) i.r0" ; Windows 10 1607+; else "error": 96
  ${IfThen} $0 < 96 ${|} StrCpy $0 96 ${|}
  IntOp $cl.Px $0 + 48
  IntOp $cl.Px $cl.Px / 96

  ; the Conform Labs fonts for the frame's own labels (the dialog font stays Segoe UI 9)
  CreateFont $cl.FontTitle "$cl.FaceDisplay" 15 600
  CreateFont $cl.FontHead "$cl.FaceDisplay" 11 600
  CreateFont $cl.FontStrong "$cl.FaceStrong" 9 600
  CreateFont $cl.FontMono "$cl.FaceMono" 8 400
  CreateFont $cl.FontLabel "$cl.FaceMonoMedium" 7 500

  SetCtlColors $HWNDPARENT "${CL_INK}" "${CL_PAPER}"
  GetDlgItem $0 $HWNDPARENT 1034 ; header band
  SetCtlColors $0 "" "${CL_SUNK}"
  GetDlgItem $0 $HWNDPARENT 1037 ; header title
  SetCtlColors $0 "${CL_INK}" "${CL_SUNK}"
  SendMessage $0 ${WM_SETFONT} $cl.FontHead 0
  GetDlgItem $0 $HWNDPARENT 1038 ; header subtitle
  SetCtlColors $0 "${CL_MUTED}" "${CL_SUNK}"
  GetDlgItem $0 $HWNDPARENT 1046 ; header image
  SetCtlColors $0 "" "${CL_SUNK}"
  StrCpy $cl.ArtHwnd $0
  StrCpy $cl.Art "header"
  Call ${UN}cl.PickArt
  SetBrandingImage /IMGID=1046 /RESIZETOFIT "$cl.Art"
  ; no branding line: the endorsement is on the sidebar
  GetDlgItem $0 $HWNDPARENT 1028
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1256
  ShowWindow $0 ${SW_HIDE}
  Call ${UN}cl.HideLines
  StrCpy $0 1035 ; above the buttons
  Call ${UN}cl.OuterRule
  StrCpy $0 1036 ; under the header band (header-band pages only: cl.HeaderRule)
  Call ${UN}cl.OuterRule
  StrCpy $cl.HeadRule $cl.cOut
  ; the title bar: dark (DWMWA_USE_IMMERSIVE_DARK_MODE is 20 on Windows 11 and Windows 10 20H1+, 19 before that),
  ; and on Windows 11 paper-sunk with ink text (DWMWA_CAPTION_COLOR 35, DWMWA_TEXT_COLOR 36)
  System::Call "dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4) i.r0"
  ${If} $0 != 0
    System::Call "dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4) i.r0"
  ${EndIf}
  System::Call "dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i ${CL_SUNK_COLORREF}, i 4) i.r0"
  System::Call "dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i ${CL_INK_COLORREF}, i 4) i.r0"
  ${For} $1 1 3 ; Next, Cancel, Back
    GetDlgItem $0 $HWNDPARENT $1
    SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
    Call ${UN}cl.DarkControl
  ${Next}

  !ifndef CL_NO_ACCENT_BUTTON
    ; the accent label exactly over the Next button; the button never draws over it (WS_CLIPSIBLINGS)
    Push $5
    GetDlgItem $0 $HWNDPARENT 1
    System::Call "*(i,i,i,i)p.r5"
    System::Call "user32::GetWindowRect(p r0, p r5)"
    System::Call "user32::MapWindowPoints(p 0, p $HWNDPARENT, p r5, i 2)"
    System::Call "*$5(i.r2, i.r3, i.r4, i.r1)" ; left, top, right, bottom
    System::Free $5
    IntOp $4 $4 - $2
    IntOp $1 $1 - $3
    IntOp $5 ${CL_SS_CENTER_V} | ${CL_WS_CHILD_VISIBLE}
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i r5, i r2, i r3, i r4, i r1, p $HWNDPARENT, p 0, p 0, p 0) p.r1'
    Pop $5
    StrCpy $cl.MainBtn $1
    SetCtlColors $cl.MainBtn "${CL_ON_ACCENT}" "${CL_ACCENT}"
    SendMessage $cl.MainBtn ${WM_SETFONT} $cl.FontStrong 0
    System::Call "user32::GetWindowLongW(p r0, i -16) i.r1"
    IntOp $1 $1 | ${CL_WS_CLIPSIBLINGS}
    System::Call "user32::SetWindowLongW(p r0, i -16, i r1)"
    ShowWindow $cl.MainBtn ${SW_HIDE}
  !endif
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; the hairline under the header band: $0 = 1 shown (header-band pages), 0 hidden (sidebar pages)
Function ${UN}cl.HeaderRule
  ${If} $0 == 1
    ShowWindow $cl.HeadRule ${SW_SHOW}
  ${Else}
    ShowWindow $cl.HeadRule ${SW_HIDE}
  ${EndIf}
FunctionEnd

; Shows or hides Back (3) and Cancel (2): $0 = "back", "cancel", "both" or "none" to hide
Function ${UN}cl.FooterButtons
  Push $1
  GetDlgItem $1 $HWNDPARENT 3
  ${If} $0 == "back"
  ${OrIf} $0 == "both"
    ShowWindow $1 ${SW_HIDE}
  ${Else}
    ShowWindow $1 ${SW_SHOW}
  ${EndIf}
  GetDlgItem $1 $HWNDPARENT 2
  ${If} $0 == "cancel"
  ${OrIf} $0 == "both"
    ShowWindow $1 ${SW_HIDE}
  ${Else}
    ShowWindow $1 ${SW_SHOW}
  ${EndIf}
  Pop $1
FunctionEnd

; the inner page of a built-in page (progress, uninstall confirmation): every child control
Function ${UN}cl.InnerPageShow
  Push $0
  Push $1
  Push $2
  Call ${UN}cl.HideLines
  StrCpy $0 "none"
  Call ${UN}cl.FooterButtons
  StrCpy $0 1
  Call ${UN}cl.HeaderRule
  FindWindow $1 "#32770" "" $HWNDPARENT
  SetCtlColors $1 "${CL_INK}" "${CL_PAPER}"
  StrCpy $0 0
  ${Do}
    FindWindow $0 "" "" $1 $0
    ${If} $0 == 0
      ${Break}
    ${EndIf}
    System::Call "user32::GetClassNameW(p r0, w .r2, i ${NSIS_MAX_STRLEN})"
    ${If} $2 == "Static"
    ${OrIf} $2 == "Edit" ; texts, the read-only "Uninstalling from" box
      SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
    ${ElseIf} $2 == "Button" ; "Show details"
      SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
      Call ${UN}cl.DarkControl
    ${ElseIf} $2 == "SysListView32" ; the details list (its colours: MUI_INSTFILESPAGE_COLORS)
      Call ${UN}cl.DarkControl
    ${ElseIf} $2 == "msctls_progress32"
      ; drawn without the visual style, so that it takes the accent colour, on paper-sunk
      System::Call "uxtheme::SetWindowTheme(p r0, w '', w '')"
      SendMessage $0 ${PBM_SETBARCOLOR} 0 ${CL_ACCENT_COLORREF}
      SendMessage $0 ${PBM_SETBKCOLOR} 0 ${CL_SUNK_COLORREF}
    ${EndIf}
  ${Loop}
  GetDlgItem $0 $1 1029 ; "Uninstalling from:"
  ${If} $0 <> 0
    SetCtlColors $0 "${CL_MUTED}" "${CL_PAPER}"
  ${EndIf}
  Call ${UN}cl.SyncMainButton
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macroend

!insertmacro _CL_SHARED_FUNCTIONS ""
!insertmacro _CL_SHARED_FUNCTIONS "un."

; ---------- installer-only helpers ----------
; A static control on dialog $cl.cP at $cl.cX $cl.cY $cl.cW $cl.cH (dialog units of that dialog), style bits
; $cl.cS, text $cl.cT, control id $cl.cI, in the dialog's font -> $cl.cOut. For pages that are not nsDialogs pages
; (the progress page) and for the outer window.
Function cl.Static
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  ; the rectangle's "right" and "bottom" carry the size: MapDialogRect scales each value on its own
  System::Call "*(i $cl.cX, i $cl.cY, i $cl.cW, i $cl.cH)p.r0"
  System::Call "user32::MapDialogRect(p $cl.cP, p r0)"
  System::Call "*$0(i.r1, i.r2, i.r3, i.r4)"
  System::Free $0
  ; never drawn over a sibling above it (the progress page's details list covers the steps)
  IntOp $0 $cl.cS | ${CL_WS_CHILD_VISIBLE}
  IntOp $0 $0 | ${CL_WS_CLIPSIBLINGS}
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "$cl.cT", i r0, i r1, i r2, i r3, i r4, p $cl.cP, p $cl.cI, p 0, p 0) p.r0'
  StrCpy $cl.cOut $0
  SendMessage $cl.cP ${WM_GETFONT} 0 0 $1
  SendMessage $cl.cOut ${WM_SETFONT} $1 0
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; $0 = control: one device pixel tall (a hairline), keeping its width
Function cl.OnePixel
  Push $1
  Push $2
  System::Call "*(i,i,i,i)p.r2"
  System::Call "user32::GetClientRect(p r0, p r2)"
  System::Call "*$2(i,i,i.r1,i)"
  System::Free $2
  System::Call "user32::SetWindowPos(p r0, p 0, i 0, i 0, i r1, i $cl.Px, i ${CL_SWP_SIZE_ONLY})"
  Pop $2
  Pop $1
FunctionEnd

; $0 = control: below its overlapping siblings, and never drawn over them (backgrounds, the sidebar image)
Function cl.SendToBack
  Push $1
  System::Call "user32::GetWindowLongW(p r0, i -16) i.r1"
  IntOp $1 $1 | ${CL_WS_CLIPSIBLINGS}
  System::Call "user32::SetWindowLongW(p r0, i -16, i r1)"
  System::Call "user32::SetWindowPos(p r0, p 1, i 0, i 0, i 0, i 0, i ${CL_SWP_ZORDER_ONLY})"
  Pop $1
FunctionEnd


; ---------- start and end (call from .onInit / un.onInit, .onGUIEnd / un.onGUIEnd) ----------
!macro CL_ONINIT
  Call cl.LoadFonts
  Call cl.DetectInstalled
!macroend
!macro CL_UNONINIT
  Call un.cl.LoadFonts
!macroend
!macro CL_ONGUIEND
  !ifdef __UNINSTALL__
    Call un.cl.UnloadFonts
  !else
    Call cl.UnloadFonts
  !endif
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
  StrCpy $cl.RemoveAll 0
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
    StrCpy $cl.ActionNote "Replaces $cl.InstalledVersion. ${CL_KEEP_NOTE}"
  ${CaseElse}
    StrCpy $cl.ActionText "Install ${CL_APP_VERSION} (you have $cl.InstalledVersion)"
    StrCpy $cl.ActionButton "&Install"
    StrCpy $cl.ActionNote "Replaces $cl.InstalledVersion with this one. ${CL_KEEP_NOTE}"
  ${EndSelect}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; ---------- building blocks for header-band pages (nsDialogs) ----------
; a hairline across the page at $0 (dialog units, e.g. "40u")
!macro CL_RULE TOP
  ${NSD_CreateLabel} 0 ${TOP} 100% 1u ""
  Pop $0
  SetCtlColors $0 "" "${CL_RULE}"
  Call cl.OnePixel
!macroend

; a mono label (uppercase, muted): "AI APPS", "OPTIONAL"
!macro CL_SECTION_LABEL TOP TEXT
  ${NSD_CreateLabel} 0 ${TOP} 100% 9u "${TEXT}"
  Pop $0
  SetCtlColors $0 "${CL_MUTED}" "${CL_PAPER}"
  SendMessage $0 ${WM_SETFONT} $cl.FontLabel 0
!macroend

; the same with run-time positions and texts (the app's rows built from what Setup found): $R0 top, $R1 title,
; $R2 note ("" for none), $R3 enabled (1/0), $R4 on-click function address (GetFunctionAddress) -> $R5 box, $R6 height
Function cl.CheckRow
  Push $0
  Push $1
  ${NSD_CreateLabel} 0 $R0u 100% 1u ""
  Pop $0
  SetCtlColors $0 "" "${CL_RULE}"
  Call cl.OnePixel
  IntOp $1 $R0 + 4
  ${NSD_CreateCheckbox} 0 $1u 8u 10u "$R1"
  Pop $R5
  SetCtlColors $R5 "${CL_INK}" "${CL_PAPER}"
  StrCpy $0 $R5
  Call cl.DarkControl
  ${NSD_CreateLabel} 13u $1u 280u 10u "$R1"
  Pop $0
  ${If} $R3 == 1
    SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
    SendMessage $0 ${WM_SETFONT} $cl.FontStrong 0
    nsDialogs::OnClick $0 $R4
  ${Else}
    SetCtlColors $0 "${CL_MUTED}" "${CL_PAPER}"
    EnableWindow $R5 0
  ${EndIf}
  StrCpy $R6 16
  ${If} $R2 != ""
    IntOp $1 $R0 + 14
    ${NSD_CreateLabel} 13u $1u 280u 9u "$R2"
    Pop $0
    SetCtlColors $0 "${CL_MUTED}" "${CL_PAPER}"
    ${If} $R3 == 1
      nsDialogs::OnClick $0 $R4
    ${EndIf}
    StrCpy $R6 25
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

; the main button's text on an app page: $0 = text with its access key ("&Install")
Function cl.SetMainButton
  Push $1
  GetDlgItem $1 $HWNDPARENT 1
  SendMessage $1 ${WM_SETTEXT} 0 "STR:$0"
  Pop $1
  Call cl.SyncMainButton
FunctionEnd

; every page of the app's own: the separators, the footer, the accent button
Function cl.AppPageShow
  Call cl.HideLines
  StrCpy $0 "none"
  Call cl.FooterButtons
  StrCpy $0 1
  Call cl.HeaderRule
  Call cl.SyncMainButton
FunctionEnd

; ---------- pages ----------
Function cl.DisableBack
  Push $0
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 0
  Pop $0
FunctionEnd

!macro CL_PAGE_MAINTENANCE
  Page custom cl.MaintenanceCreate cl.MaintenanceLeave
!macroend

; One option at TOP (dialog units): a hairline, the radio button (its text is the real option name for screen
; readers; only its circle shows), the title beside it (IBM Plex Sans SemiBold) and a muted note, all clickable.
!macro _CL_OPTION TOP RADIO TITLE NOTE ONCLICK
  !insertmacro CL_RULE ${TOP}u
  !define /redef /math _CL_T ${TOP} + 5
  ${NSD_CreateRadioButton} 0 ${_CL_T}u 8u 10u "${TITLE}"
  Pop ${RADIO}
  SetCtlColors ${RADIO} "${CL_INK}" "${CL_PAPER}"
  StrCpy $0 ${RADIO}
  Call cl.DarkControl
  ${NSD_OnClick} ${RADIO} ${ONCLICK}
  ${NSD_CreateLabel} 13u ${_CL_T}u 280u 10u "${TITLE}"
  Pop $0
  SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
  SendMessage $0 ${WM_SETFONT} $cl.FontStrong 0
  ${NSD_OnClick} $0 ${ONCLICK}
  !define /redef /math _CL_T ${TOP} + 16
  ${NSD_CreateLabel} 13u ${_CL_T}u 280u 18u "${NOTE}"
  Pop $0
  SetCtlColors $0 "${CL_MUTED}" "${CL_PAPER}"
  ${NSD_OnClick} $0 ${ONCLICK}
!macroend

; "Update or uninstall": the page for a Setup run on a computer that has the app.
Function cl.MaintenanceCreate
  ${If} $cl.Installed != 1
  ${OrIf} ${Silent}
    Abort ; not installed (or silent): the normal install, starting at the welcome page
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Update or uninstall ${CL_APP_NAME}" "Version $cl.InstalledVersion is installed for your Windows account."

  nsDialogs::Create 1018
  Pop $cl.Dialog
  ${If} $cl.Dialog == error
    Abort
  ${EndIf}
  SetCtlColors $cl.Dialog "${CL_INK}" "${CL_PAPER}"

  !insertmacro _CL_OPTION 4 $cl.RadioInstall "$cl.ActionText" "$cl.ActionNote" cl.ChooseInstall
  ${NSD_AddStyle} $cl.RadioInstall ${WS_GROUP}
  !insertmacro _CL_OPTION 44 $cl.RadioUninstall "Uninstall" "${CL_UNINSTALL_NOTE}" cl.ChooseUninstall
  StrCpy $cl.RemoveAllBox ""
  !ifdef CL_UNINSTALL_ALL
    ; enabled only while Uninstall is chosen
    ${NSD_CreateCheckbox} 13u 81u 8u 10u "${CL_UNINSTALL_ALL}"
    Pop $cl.RemoveAllBox
    SetCtlColors $cl.RemoveAllBox "${CL_INK}" "${CL_PAPER}"
    StrCpy $0 $cl.RemoveAllBox
    Call cl.DarkControl
    ${NSD_CreateLabel} 25u 81u 268u 10u "${CL_UNINSTALL_ALL}"
    Pop $cl.RemoveAllLabel
    ${NSD_OnClick} $cl.RemoveAllLabel cl.ToggleRemoveAll
    !insertmacro CL_RULE 96u
  !else
    !insertmacro CL_RULE 80u
  !endif

  ${NSD_Check} $cl.RadioInstall
  Push $cl.RadioInstall
  Call cl.ChooseInstall
  Call cl.AppPageShow
  StrCpy $0 "back" ; the first page: Next and Cancel only
  Call cl.FooterButtons
  nsDialogs::Show
FunctionEnd

Function cl.ChooseInstall
  Pop $0
  ${NSD_Check} $cl.RadioInstall
  ${NSD_Uncheck} $cl.RadioUninstall
  ${If} $cl.RemoveAllBox != ""
    EnableWindow $cl.RemoveAllBox 0
    SetCtlColors $cl.RemoveAllLabel "${CL_MUTED}" "${CL_PAPER}"
    System::Call "user32::InvalidateRect(p $cl.RemoveAllLabel, p 0, i 1)"
  ${EndIf}
  StrCpy $0 "&Next"
  Call cl.SetMainButton
FunctionEnd

Function cl.ChooseUninstall
  Pop $0
  ${NSD_Check} $cl.RadioUninstall
  ${NSD_Uncheck} $cl.RadioInstall
  ${If} $cl.RemoveAllBox != ""
    EnableWindow $cl.RemoveAllBox 1
    SetCtlColors $cl.RemoveAllLabel "${CL_INK}" "${CL_PAPER}"
    System::Call "user32::InvalidateRect(p $cl.RemoveAllLabel, p 0, i 1)"
  ${EndIf}
  StrCpy $0 "U&ninstall"
  Call cl.SetMainButton
FunctionEnd

!ifdef CL_UNINSTALL_ALL
Function cl.ToggleRemoveAll
  Pop $0
  ${NSD_GetState} $cl.RadioUninstall $0
  ${If} $0 != ${BST_CHECKED}
    Return
  ${EndIf}
  ${NSD_GetState} $cl.RemoveAllBox $0
  ${If} $0 == ${BST_CHECKED}
    ${NSD_Uncheck} $cl.RemoveAllBox
  ${Else}
    ${NSD_Check} $cl.RemoveAllBox
  ${EndIf}
FunctionEnd
!endif

Function cl.MaintenanceLeave
  ${NSD_GetState} $cl.RadioUninstall $0
  ${If} $0 != ${BST_CHECKED}
    Return ; update / reinstall: on to the app's next page (the welcome page is skipped)
  ${EndIf}
  StrCpy $cl.RemoveAll 0
  StrCpy $1 ""
  ${If} $cl.RemoveAllBox != ""
    ${NSD_GetState} $cl.RemoveAllBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $cl.RemoveAll 1
      StrCpy $1 " /ALL"
    ${EndIf}
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
  ExecWait '"$PLUGINSDIR\uninstall.exe"$1 _?=$cl.InstalledDir' $0
  ${If} ${Errors}
    StrCpy $0 "error"
  ${EndIf}
  Delete "$PLUGINSDIR\uninstall.exe"
  ${If} $0 == 0
    !ifdef CL_AFTER_UNINSTALL
      Call ${CL_AFTER_UNINSTALL}
    !endif
    Quit ; uninstalled; the uninstaller showed the result
  ${EndIf}
  ShowWindow $HWNDPARENT ${SW_SHOW}
  BringToFront
  ${If} $0 == "error"
    MessageBox MB_ICONSTOP "Could not start the ${CL_APP_NAME} uninstaller ($cl.InstalledDir\${CL_UNINST_EXE})."
  ${EndIf}
  Abort ; cancelled or failed: stay on this page
FunctionEnd

; The sidebar pages (welcome, finish): MUI's page with its image replaced by the size nearest the control, the
; version over it at the bottom (IBM Plex Mono, muted), and the page's own labels from 124u.
!macro _CL_SIDEBAR IMAGE HANDLE
  StrCpy $cl.ArtHwnd ${IMAGE}
  StrCpy $cl.Art "wizard"
  Call cl.PickArt
  Push ${HANDLE}
  ${NSD_SetStretchedImage} ${IMAGE} "$cl.Art" ${HANDLE}
  Exch $0
  ${NSD_FreeImage} $0
  Pop $0
  StrCpy $0 ${IMAGE}
  Call cl.SendToBack
  ${NSD_CreateLabel} 12u 178u 90u 9u "${CL_APP_VERSION}"
  Pop $0
  SetCtlColors $0 "${CL_MUTED}" "${CL_SUNK}"
  SendMessage $0 ${WM_SETFONT} $cl.FontMono 0
  Call cl.BringToTop
!macroend

!macro CL_PAGE_WELCOME
  !define CL_WELCOME_TITLE "${MUI_WELCOMEPAGE_TITLE}" ; MUI forgets its page defines once the page is inserted
  !define MUI_PAGE_CUSTOMFUNCTION_PRE cl.WelcomePre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW cl.WelcomeShow
  !insertmacro MUI_PAGE_WELCOME
  Function cl.WelcomePre
    ${If} $cl.Installed == 1
      Abort ; the maintenance page replaces the welcome page
    ${EndIf}
  FunctionEnd
  Function cl.WelcomeShow
    !insertmacro _CL_SIDEBAR $mui.WelcomePage.Image $mui.WelcomePage.Image.Bitmap
    ; the title in Space Grotesk; the text as the design's paragraphs (ink, then muted)
    ShowWindow $mui.WelcomePage.Text ${SW_HIDE}
    ShowWindow $mui.WelcomePage.Title ${SW_HIDE}
    ${NSD_CreateLabel} 124u 20u 196u 16u "${CL_WELCOME_TITLE}"
    Pop $0
    SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
    SendMessage $0 ${WM_SETFONT} $cl.FontTitle 0
    ${NSD_CreateLabel} 124u 38u 196u 10u "${CL_WELCOME_SUB}"
    Pop $0
    SetCtlColors $0 "${CL_MUTED}" "${CL_PAPER}"
    ${NSD_CreateLabel} 124u 56u 196u 34u "${CL_WELCOME_TEXT1}"
    Pop $0
    SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
    ${NSD_CreateLabel} 124u 94u 196u 18u "${CL_WELCOME_TEXT2}"
    Pop $0
    SetCtlColors $0 "${CL_MUTED}" "${CL_PAPER}"
    ${NSD_CreateLabel} 124u 116u 196u 10u "${CL_WELCOME_TEXT3}"
    Pop $0
    SetCtlColors $0 "${CL_MUTED}" "${CL_PAPER}"
    Call cl.HideLines
    StrCpy $0 0
    Call cl.HeaderRule
    StrCpy $0 "none"
    Call cl.FooterButtons
    Call cl.DisableBack ; the first page (NSIS counts the skipped maintenance page before it)
    Call cl.SyncMainButton
  FunctionEnd
!macroend

; ---------- the progress page: plain steps over the raw log ----------
; Rows (from 26u, 12u each): a hairline, the glyph, the step, its state in mono capitals (NEXT, NOW, DONE, FAILED).
; Control ids 1300 + 4 * step + 0 hairline, 1 glyph, 2 text, 3 state, so the install section can find them.
!macro CL_PAGE_INSTFILES
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW cl.InstFilesShow
  !insertmacro MUI_PAGE_INSTFILES
  Function cl.InstFilesShow
    Call cl.InnerPageShow
    FindWindow $cl.InnerDlg "#32770" "" $HWNDPARENT
    StrCpy $cl.StepCount 0
    StrCpy $cl.StepNow 0
    StrCpy $cl.StepY 26
    ; the status line (mono) in place of MUI's, the progress bar thin under it
    GetDlgItem $0 $cl.InnerDlg 1006
    ShowWindow $0 ${SW_HIDE}
    StrCpy $cl.cP $cl.InnerDlg
    StrCpy $cl.cX 0
    StrCpy $cl.cY 0
    StrCpy $cl.cW 300
    StrCpy $cl.cH 12
    StrCpy $cl.cS 0
    StrCpy $cl.cT ""
    StrCpy $cl.cI 1299
    Call cl.Static
    StrCpy $cl.Status $cl.cOut
    SetCtlColors $cl.Status "${CL_INK}" "${CL_PAPER}"
    SendMessage $cl.Status ${WM_SETFONT} $cl.FontMono 0
    GetDlgItem $0 $cl.InnerDlg 1004 ; progress bar
    StrCpy $cl.cX 0
    StrCpy $cl.cY 15
    StrCpy $cl.cW 300
    StrCpy $cl.cH 3
    Call cl.PlaceDialogUnits
    ; the glyphs for this scaling (on paper)
    StrCpy $cl.cY 0
    StrCpy $cl.cW 5
    StrCpy $cl.cH 5
    StrCpy $cl.cS ${CL_SS_BITMAP_CENTER}
    StrCpy $cl.cI 1298
    Call cl.Static
    StrCpy $cl.ArtHwnd $cl.cOut
    StrCpy $cl.Art "glyph"
    Call cl.PickArt
    System::Call "user32::DestroyWindow(p $cl.cOut)"
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\cl\glyph-done-paper-$cl.Art.bmp", i 0, i 0, i 0, i 0x10) p.s'
    Pop $cl.GDone
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\cl\glyph-skipped-paper-$cl.Art.bmp", i 0, i 0, i 0, i 0x10) p.s'
    Pop $cl.GNow
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\cl\glyph-failed-paper-$cl.Art.bmp", i 0, i 0, i 0, i 0x10) p.s'
    Pop $cl.GFailed
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\cl\glyph-waiting-paper-$cl.Art.bmp", i 0, i 0, i 0, i 0x10) p.s'
    Pop $cl.GNext
    !ifdef CL_INSTFILES_STEPS
      Call ${CL_INSTFILES_STEPS}
    !endif
    ; "Show details" under the steps; the details list, when shown, covers the steps
    IntOp $1 $cl.StepY + 6
    GetDlgItem $0 $cl.InnerDlg 1027
    StrCpy $cl.cX 0
    StrCpy $cl.cY $1
    StrCpy $cl.cW 60
    StrCpy $cl.cH 14
    Call cl.PlaceDialogUnits
    GetDlgItem $0 $cl.InnerDlg 1016
    StrCpy $cl.cX 0
    StrCpy $cl.cY 24
    StrCpy $cl.cW 300
    StrCpy $cl.cH 116
    Call cl.PlaceDialogUnits
    Call cl.BringToTop
  FunctionEnd
!macroend

; $0 = control on $cl.InnerDlg: moved to $cl.cX $cl.cY $cl.cW $cl.cH (dialog units)
Function cl.PlaceDialogUnits
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  System::Call "*(i $cl.cX, i $cl.cY, i $cl.cW, i $cl.cH)p.r5" ; x, y, width, height: each scaled on its own
  System::Call "user32::MapDialogRect(p $cl.InnerDlg, p r5)"
  System::Call "*$5(i.r1, i.r2, i.r3, i.r4)"
  System::Free $5
  System::Call "user32::MoveWindow(p r0, i r1, i r2, i r3, i r4, i 1)"
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
FunctionEnd

; Push "Installing Surehand MCP" / Call cl.StepAdd: a step, waiting (from CL_INSTFILES_STEPS)
Function cl.StepAdd
  Exch $1
  Push $0
  Push $2
  IntOp $2 $cl.StepCount * 4
  IntOp $2 $2 + 1300
  StrCpy $cl.cP $cl.InnerDlg
  StrCpy $cl.cX 0
  StrCpy $cl.cY $cl.StepY
  StrCpy $cl.cW 300
  StrCpy $cl.cH 1
  StrCpy $cl.cS 0
  StrCpy $cl.cT ""
  StrCpy $cl.cI $2
  Call cl.Static
  SetCtlColors $cl.cOut "" "${CL_RULE}"
  StrCpy $0 $cl.cOut
  Call cl.OnePixel
  IntOp $cl.cY $cl.StepY + 4
  StrCpy $cl.cW 5
  StrCpy $cl.cH 5
  StrCpy $cl.cS ${CL_SS_BITMAP_CENTER}
  IntOp $cl.cI $2 + 1
  Call cl.Static
  SendMessage $cl.cOut ${CL_STM_SETIMAGE} 0 $cl.GNext
  StrCpy $cl.cX 10
  IntOp $cl.cY $cl.StepY + 3
  StrCpy $cl.cW 228
  StrCpy $cl.cH 9
  StrCpy $cl.cS 0
  StrCpy $cl.cT "$1"
  IntOp $cl.cI $2 + 2
  Call cl.Static
  SetCtlColors $cl.cOut "${CL_MUTED}" "${CL_PAPER}"
  StrCpy $cl.cX 240
  StrCpy $cl.cW 60
  StrCpy $cl.cS ${CL_SS_RIGHT}
  StrCpy $cl.cT "NEXT"
  IntOp $cl.cI $2 + 3
  Call cl.Static
  SetCtlColors $cl.cOut "${CL_MUTED}" "${CL_PAPER}"
  SendMessage $cl.cOut ${WM_SETFONT} $cl.FontLabel 0
  IntOp $cl.StepCount $cl.StepCount + 1
  IntOp $cl.StepY $cl.StepY + 12
  ; the closing hairline under the last step
  System::Call "user32::GetDlgItem(p $cl.InnerDlg, i 1297) p.r0"
  ${If} $0 <> 0
    System::Call "user32::DestroyWindow(p r0)"
  ${EndIf}
  StrCpy $cl.cX 0
  StrCpy $cl.cY $cl.StepY
  StrCpy $cl.cW 300
  StrCpy $cl.cH 1
  StrCpy $cl.cS 0
  StrCpy $cl.cT ""
  StrCpy $cl.cI 1297
  Call cl.Static
  SetCtlColors $cl.cOut "" "${CL_RULE}"
  StrCpy $0 $cl.cOut
  Call cl.OnePixel
  Pop $2
  Pop $0
  Pop $1
FunctionEnd

; Push "done" | "failed" / Call cl.StepEnd: the current step's outcome; the next one starts (from the install
; section; nothing happens when Setup is silent)
Function cl.StepEnd
  Exch $1
  Push $0
  Push $2
  Push $3
  ${If} $cl.InnerDlg != ""
  ${AndIf} $cl.StepNow < $cl.StepCount
    IntOp $2 $cl.StepNow * 4
    IntOp $2 $2 + 1300
    IntOp $3 $2 + 1
    GetDlgItem $0 $cl.InnerDlg $3
    IntOp $3 $2 + 2
    ${If} $1 == "done"
      SendMessage $0 ${CL_STM_SETIMAGE} 0 $cl.GDone
      GetDlgItem $0 $cl.InnerDlg $3
      SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
      SendMessage $cl.InnerDlg ${WM_GETFONT} 0 0 $1
      SendMessage $0 ${WM_SETFONT} $1 1 ; back to the dialog font
      IntOp $3 $2 + 3
      GetDlgItem $0 $cl.InnerDlg $3
      SetCtlColors $0 "${CL_ACCENT}" "${CL_PAPER}"
      SendMessage $0 ${WM_SETTEXT} 0 "STR:DONE"
    ${Else}
      SendMessage $0 ${CL_STM_SETIMAGE} 0 $cl.GFailed
      GetDlgItem $0 $cl.InnerDlg $3
      SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
      IntOp $3 $2 + 3
      GetDlgItem $0 $cl.InnerDlg $3
      SetCtlColors $0 "${CL_REFUSED}" "${CL_PAPER}"
      SendMessage $0 ${WM_SETTEXT} 0 "STR:FAILED"
    ${EndIf}
    System::Call "user32::InvalidateRect(p $cl.InnerDlg, p 0, i 1)"
  ${EndIf}
  IntOp $cl.StepNow $cl.StepNow + 1
  Pop $3
  Pop $2
  Pop $0
  Pop $1
FunctionEnd

; Call cl.StepStart: the current step is running: its glyph, its name in IBM Plex Sans SemiBold, the status line
Function cl.StepStart
  Push $0
  Push $1
  Push $2
  Push $3
  ${If} $cl.InnerDlg != ""
  ${AndIf} $cl.StepNow < $cl.StepCount
    IntOp $2 $cl.StepNow * 4
    IntOp $2 $2 + 1300
    IntOp $3 $2 + 1
    GetDlgItem $0 $cl.InnerDlg $3
    SendMessage $0 ${CL_STM_SETIMAGE} 0 $cl.GNow
    IntOp $3 $2 + 2
    GetDlgItem $0 $cl.InnerDlg $3
    SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
    SendMessage $0 ${WM_SETFONT} $cl.FontStrong 1
    System::Call "user32::GetWindowTextW(p r0, w .r1, i 256)"
    SendMessage $cl.Status ${WM_SETTEXT} 0 "STR:$1…"
    IntOp $3 $2 + 3
    GetDlgItem $0 $cl.InnerDlg $3
    SendMessage $0 ${WM_SETTEXT} 0 "STR:NOW"
    System::Call "user32::InvalidateRect(p $cl.InnerDlg, p 0, i 1)"
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; ---------- the finish page: the results and the next steps ----------
; The results box: paper-sunk under a 2 px ink rule, one row per [summary.<i>] of CL_RESULTS_INI (a glyph, the text
; in IBM Plex Mono); then the numbered next steps ([next]); then the help link.
!macro CL_PAGE_FINISH
  !define CL_FINISH_TITLE "${MUI_FINISHPAGE_TITLE}"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW cl.FinishShow
  !insertmacro MUI_PAGE_FINISH
  Function cl.FinishShow
    !insertmacro _CL_SIDEBAR $mui.FinishPage.Image $mui.FinishPage.Image.Bitmap
    ShowWindow $mui.FinishPage.Title ${SW_HIDE}
    ShowWindow $mui.FinishPage.Text ${SW_HIDE}
    ${NSD_CreateLabel} 124u 14u 196u 16u "${CL_FINISH_TITLE}"
    Pop $0
    SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
    SendMessage $0 ${WM_SETFONT} $cl.FontTitle 0
    StrCpy $R9 36 ; the next free line (dialog units)
    !ifdef CL_RESULTS_INI
      Call cl.FinishResults
    !endif
    !ifdef CL_HELP_URL
      ${NSD_CreateLabel} 124u 177u 22u 9u "Help:"
      Pop $0
      SetCtlColors $0 "${CL_MUTED}" "${CL_PAPER}"
      ${NSD_CreateLink} 145u 177u 150u 10u "${CL_HELP_TEXT}"
      Pop $cl.HelpLink
      SetCtlColors $cl.HelpLink "${CL_INK}" "${CL_PAPER}"
      CreateFont $1 "$(^Font)" "$(^FontSize)" 400 /UNDERLINE
      SendMessage $cl.HelpLink ${WM_SETFONT} $1 0
      ${NSD_OnClick} $cl.HelpLink cl.HelpClick
    !endif
    Call cl.HideLines
    StrCpy $0 0
    Call cl.HeaderRule
    StrCpy $0 "both" ; Finish only
    Call cl.FooterButtons
    Call cl.SyncMainButton
  FunctionEnd
  !ifdef CL_HELP_URL
    Function cl.HelpClick
      Pop $0
      ExecShell "open" "${CL_HELP_URL}"
    FunctionEnd
  !endif
!ifdef CL_RESULTS_INI
; rows of the results box, from $R9 down; leaves $R9 under the next steps
Function cl.FinishResults
  ReadINIStr $R8 "${CL_RESULTS_INI}" "summary" "count"
  ${If} $R8 == ""
    Return
  ${EndIf}
  ; the glyph size for this scaling: measured on a 5u control
  ${NSD_CreateLabel} 0 0 5u 5u ""
  Pop $0
  StrCpy $cl.ArtHwnd $0
  StrCpy $cl.Art "glyph"
  Call cl.PickArt
  StrCpy $R7 $cl.Art
  ShowWindow $0 ${SW_HIDE}
  ; the 2 px ink rule, then the sunk box (sized when the rows are known)
  ${NSD_CreateLabel} 124u $R9u 196u 2u ""
  Pop $0
  SetCtlColors $0 "" "${CL_INK}"
  System::Call "*(i,i,i,i)p.r2"
  System::Call "user32::GetClientRect(p r0, p r2)"
  System::Call "*$2(i,i,i.r1,i)"
  System::Free $2
  IntOp $2 $cl.Px * 2
  System::Call "user32::SetWindowPos(p r0, p 0, i 0, i 0, i r1, i r2, i ${CL_SWP_SIZE_ONLY})"
  IntOp $R9 $R9 + 1
  ${NSD_CreateLabel} 124u $R9u 196u 10u ""
  Pop $R6 ; the box
  SetCtlColors $R6 "" "${CL_SUNK}"
  IntOp $R5 $R9 + 4 ; first row
  StrCpy $R4 0
  ${DoWhile} $R4 < $R8
    ReadINIStr $1 "${CL_RESULTS_INI}" "summary.$R4" "kind"
    ReadINIStr $2 "${CL_RESULTS_INI}" "summary.$R4" "text"
    ${If} $1 != "done"
    ${AndIf} $1 != "failed"
      StrCpy $1 "skipped"
    ${EndIf}
    ; about 46 IBM Plex Mono characters fit on a line
    StrLen $3 $2
    IntOp $3 $3 + 45
    IntOp $3 $3 / 46
    ${IfThen} $3 < 1 ${|} StrCpy $3 1 ${|}
    IntOp $3 $3 * 10
    IntOp $4 $R5 + 2
    ${NSD_CreateBitmap} 130u $4u 5u 5u ""
    Pop $0
    ${NSD_SetImage} $0 "$PLUGINSDIR\cl\glyph-$1-sunk-$R7.bmp" $5
    ${NSD_CreateLabel} 140u $R5u 176u $3u "$2"
    Pop $0
    SetCtlColors $0 "${CL_INK}" "${CL_SUNK}"
    ${If} $1 == "skipped"
      SetCtlColors $0 "${CL_MUTED}" "${CL_SUNK}"
    ${EndIf}
    SendMessage $0 ${WM_SETFONT} $cl.FontMono 0
    IntOp $R5 $R5 + $3
    IntOp $R4 $R4 + 1
  ${Loop}
  ; the box down to the last row, behind the rows
  IntOp $3 $R5 - $R9
  IntOp $3 $3 + 3
  StrCpy $cl.InnerDlg $mui.FinishPage
  StrCpy $0 $R6
  StrCpy $cl.cX 124
  StrCpy $cl.cY $R9
  StrCpy $cl.cW 196
  StrCpy $cl.cH $3
  Call cl.PlaceDialogUnits
  StrCpy $cl.InnerDlg ""
  Call cl.SendToBack
  IntOp $R9 $R5 + 9

  ; the next steps, numbered
  ReadINIStr $R8 "${CL_RESULTS_INI}" "next" "count"
  StrCpy $R4 0
  ${DoWhile} $R4 < $R8
    ReadINIStr $2 "${CL_RESULTS_INI}" "next" "$R4"
    IntOp $1 $R4 + 1
    ${NSD_CreateLabel} 124u $R9u 9u 9u "$1."
    Pop $0
    SetCtlColors $0 "${CL_MUTED}" "${CL_PAPER}"
    ; about 48 Segoe UI characters on a line
    StrLen $3 $2
    IntOp $3 $3 + 47
    IntOp $3 $3 / 48
    ${IfThen} $3 < 1 ${|} StrCpy $3 1 ${|}
    IntOp $3 $3 * 9
    ${NSD_CreateLabel} 134u $R9u 186u $3u "$2"
    Pop $0
    SetCtlColors $0 "${CL_INK}" "${CL_PAPER}"
    IntOp $R9 $R9 + $3
    IntOp $R9 $R9 + 3
    IntOp $R4 $R4 + 1
  ${Loop}
FunctionEnd
!endif
!macroend


!macro CL_UNPAGE_CONFIRM
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.cl.ConfirmShow
  !insertmacro MUI_UNPAGE_CONFIRM
  Function un.cl.ConfirmShow
    Call un.cl.InnerPageShow
    !ifdef CL_UNCONFIRM_SHOW
      Call ${CL_UNCONFIRM_SHOW}
    !endif
  FunctionEnd
!macroend

!macro CL_UNPAGE_INSTFILES
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.cl.InnerPageShow
  !insertmacro MUI_UNPAGE_INSTFILES
!macroend
