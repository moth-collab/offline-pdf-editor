; Extra installer steps (included by electron-builder, see electron-builder.yml).
; Registers the app with Windows "Default apps" so it can be chosen as the
; default PDF program (Windows asks the user to confirm; apps cannot force it).
; SHELL_CONTEXT is HKCU for per-user installs and HKLM for per-machine installs.

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\OfflinePDFEditor\Capabilities" "ApplicationName" "Offline PDF Editor"
  WriteRegStr SHELL_CONTEXT "Software\OfflinePDFEditor\Capabilities" "ApplicationDescription" "Edit, sign, OCR and convert PDF documents offline."
  WriteRegStr SHELL_CONTEXT "Software\OfflinePDFEditor\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\OfflinePDFEditor\Capabilities\FileAssociations" ".pdf" "OfflinePDFEditor.pdf"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "Offline PDF Editor" "Software\OfflinePDFEditor\Capabilities"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".pdf" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Offline PDF Editor"
  ; version 1.0.0 registered the generic ProgID "PDF Document": remove it, but
  ; only when it still points to this program (never touch another app's entry)
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\PDF Document\shell\open\command" ""
  StrCmp $0 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"' 0 skipLegacyProgId
    DeleteRegKey SHELL_CONTEXT "Software\Classes\PDF Document"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "PDF Document"
  skipLegacyProgId:
  ; tell Explorer that file associations changed
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "Offline PDF Editor"
  DeleteRegKey SHELL_CONTEXT "Software\OfflinePDFEditor\Capabilities"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\OfflinePDFEditor"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
