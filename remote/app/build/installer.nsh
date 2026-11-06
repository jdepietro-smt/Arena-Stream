; Registers the elevated-access service after install and removes it on uninstall.
!macro customInstall
  nsExec::ExecToLog '"$INSTDIR\resources\service\ArenaRemoteService.exe" install --client "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
!macroend
!macro customUnInstall
  nsExec::ExecToLog '"$INSTDIR\resources\service\ArenaRemoteService.exe" uninstall'
!macroend
