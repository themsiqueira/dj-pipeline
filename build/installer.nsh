; electron-builder merges this file; ${PRODUCT_NAME} and ${PRODUCT_FILENAME} are defined by the template.
; Adds a Start Menu shortcut next to the app shortcut so users can uninstall without opening Settings.

!macro customInstall
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall ${PRODUCT_NAME}.lnk" "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall ${PRODUCT_NAME}.lnk"
!macroend
