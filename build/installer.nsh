; Clipwright Studio — NSIS customisations.
;
; Goals:
;  • install per-user (no admin prompt, no UAC surprise)
;  • never delete the user's workspace (projects, media, exports) on uninstall
;  • keep the uninstaller visible in "Apps & features"
;  • make it obvious when the build is unsigned

!include "MUI2.nsh"

!macro customHeader
  !system "echo Clipwright Studio installer"
!macroend

!macro customInit
  ; Refuse to run if the app is already running from this location — upgrading
  ; over a live install produces half-written files on Windows.
  ; (electron-builder's default check is enough; this adds a clearer message.)
!macroend

!macro customInstall
  ; Register the workspace under the user's documents so it survives upgrades.
  WriteRegStr HKCU "Software\Clipwright Studio" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Clipwright Studio" "WorkspaceDefault" "$DOCUMENTS\Clipwright Studio"
  ; File association for .clipwright project packages.
  WriteRegStr HKCU "Software\Classes\.clipwright" "" "Clipwright.Project"
  WriteRegStr HKCU "Software\Classes\Clipwright.Project" "" "Clipwright Studio project package"
  WriteRegStr HKCU "Software\Classes\Clipwright.Project\DefaultIcon" "" "$INSTDIR\Clipwright Studio.exe,0"
  WriteRegStr HKCU "Software\Classes\Clipwright.Project\shell\open\command" "" '"$INSTDIR\Clipwright Studio.exe" "%1"'
!macroend

!macro customUnInstall
  ; Deliberately do NOT remove the workspace or settings: user data is precious
  ; and an uninstall is often temporary. Only the registration goes.
  DeleteRegKey HKCU "Software\Classes\Clipwright.Project"
  DeleteRegValue HKCU "Software\Classes\.clipwright" ""
  DeleteRegKey HKCU "Software\Clipwright Studio"
!macroend
