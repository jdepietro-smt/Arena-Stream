; Registers the elevated-access service and a private-network firewall rule (direct mode listens on TCP 8951).
!macro customInstall
  nsExec::ExecToLog '"$INSTDIR\resources\service\ArenaRemoteService.exe" install --client "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Arena Remote" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" profile=private enable=yes'
!macroend
!macro customUnInstall
  nsExec::ExecToLog '"$INSTDIR\resources\service\ArenaRemoteService.exe" uninstall'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Arena Remote"'
!macroend
