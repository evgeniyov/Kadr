; Kadr — Windows Explorer integration (per-user, never changes default apps):
;  * "Open with" lists Kadr for images and videos (OpenWithProgids);
;  * right click on any image / video → "Редактировать в Kadr".

!macro KadrOpenWith EXT PROGID
  WriteRegStr HKCU "Software\Classes\${EXT}\OpenWithProgids" "${PROGID}" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kadr.exe\SupportedTypes" "${EXT}" ""
!macroend

!macro KadrRemoveOpenWith EXT PROGID
  DeleteRegValue HKCU "Software\Classes\${EXT}\OpenWithProgids" "${PROGID}"
!macroend

!macro KadrProgId PROGID DESC
  WriteRegStr HKCU "Software\Classes\${PROGID}" "" "${DESC}"
  WriteRegStr HKCU "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\Kadr.exe,0"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open" "FriendlyAppName" "Kadr"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\Kadr.exe" "%1"'
!macroend

!macro KadrContextMenu KIND
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${KIND}\shell\KadrEdit" "" "Редактировать в Kadr"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${KIND}\shell\KadrEdit" "Icon" "$INSTDIR\Kadr.exe,0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${KIND}\shell\KadrEdit\command" "" '"$INSTDIR\Kadr.exe" "%1"'
!macroend

!macro customInstall
  !insertmacro KadrProgId "Kadr.Image" "Kadr Image"
  !insertmacro KadrProgId "Kadr.Video" "Kadr Video"
  WriteRegStr HKCU "Software\Classes\Applications\Kadr.exe" "FriendlyAppName" "Kadr"
  WriteRegStr HKCU "Software\Classes\Applications\Kadr.exe\shell\open\command" "" '"$INSTDIR\Kadr.exe" "%1"'
  !insertmacro KadrOpenWith ".png" "Kadr.Image"
  !insertmacro KadrOpenWith ".jpg" "Kadr.Image"
  !insertmacro KadrOpenWith ".jpeg" "Kadr.Image"
  !insertmacro KadrOpenWith ".webp" "Kadr.Image"
  !insertmacro KadrOpenWith ".gif" "Kadr.Image"
  !insertmacro KadrOpenWith ".bmp" "Kadr.Image"
  !insertmacro KadrOpenWith ".tif" "Kadr.Image"
  !insertmacro KadrOpenWith ".tiff" "Kadr.Image"
  !insertmacro KadrOpenWith ".mp4" "Kadr.Video"
  !insertmacro KadrOpenWith ".mov" "Kadr.Video"
  !insertmacro KadrOpenWith ".m4v" "Kadr.Video"
  !insertmacro KadrOpenWith ".webm" "Kadr.Video"
  !insertmacro KadrOpenWith ".mkv" "Kadr.Video"
  !insertmacro KadrOpenWith ".avi" "Kadr.Video"
  !insertmacro KadrContextMenu "image"
  !insertmacro KadrContextMenu "video"
  ; Tell Explorer that associations changed.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Kadr.Image"
  DeleteRegKey HKCU "Software\Classes\Kadr.Video"
  DeleteRegKey HKCU "Software\Classes\Applications\Kadr.exe"
  !insertmacro KadrRemoveOpenWith ".png" "Kadr.Image"
  !insertmacro KadrRemoveOpenWith ".jpg" "Kadr.Image"
  !insertmacro KadrRemoveOpenWith ".jpeg" "Kadr.Image"
  !insertmacro KadrRemoveOpenWith ".webp" "Kadr.Image"
  !insertmacro KadrRemoveOpenWith ".gif" "Kadr.Image"
  !insertmacro KadrRemoveOpenWith ".bmp" "Kadr.Image"
  !insertmacro KadrRemoveOpenWith ".tif" "Kadr.Image"
  !insertmacro KadrRemoveOpenWith ".tiff" "Kadr.Image"
  !insertmacro KadrRemoveOpenWith ".mp4" "Kadr.Video"
  !insertmacro KadrRemoveOpenWith ".mov" "Kadr.Video"
  !insertmacro KadrRemoveOpenWith ".m4v" "Kadr.Video"
  !insertmacro KadrRemoveOpenWith ".webm" "Kadr.Video"
  !insertmacro KadrRemoveOpenWith ".mkv" "Kadr.Video"
  !insertmacro KadrRemoveOpenWith ".avi" "Kadr.Video"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\image\shell\KadrEdit"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\video\shell\KadrEdit"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
