; ============================================================================
; 讲界视频工坊 Windows x64 离线完整安装包 (Unicode NSIS 3.x)
; 特性：
;   - 严格 Per-User 免 UAC (RequestExecutionLevel user)
;   - 默认安装至 %LOCALAPPDATA%\Programs\Jiangjie，版本化原子布局
;   - 创建桌面快捷方式与开始菜单入口
;   - 写入标准 HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Jiangjie
;   - 卸载时询问是否保留 %APPDATA%\Jiangjie 用户创作数据（默认保留）
;   - 双击安装完成后自动拉起 Jiangjie.exe；静默 /S 或 /NOLAUNCH 时不自动拉起
;   - 支持双阶段卸载器签名 (GENERATE_UNINSTALLER_ONLY / PREBUILT_UNINSTALLER)
; ============================================================================

Unicode True
ManifestDPIAware true
ManifestSupportedOS Win10
RequestExecutionLevel user

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef APP_NAME
  !define APP_NAME "讲界视频工坊"
!endif
!ifndef APP_ID
  !define APP_ID "Jiangjie"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "0.2.1"
!endif
!ifndef APP_VI_VERSION
  !define APP_VI_VERSION "0.2.1.0"
!endif
!ifndef RELEASE_SEQUENCE
  !define RELEASE_SEQUENCE "2"
!endif
!ifndef RELEASE_CHANNEL
  !define RELEASE_CHANNEL "stable"
!endif
!ifndef APP_PUBLISHER
  !define APP_PUBLISHER "讲界视频工坊 (Jiangjie Studio)"
!endif
!ifndef APP_URL
  !define APP_URL "https://jiangjie.gingers.cloud/"
!endif
!ifndef STAGE_DIR
  !define STAGE_DIR "..\..\..\build\win-desktop"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "..\..\..\build\win-release\Jiangjie-Setup-Offline-x64.exe"
!endif
!ifndef UNINSTALL_REG_KEY
  !define UNINSTALL_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
!endif

Name "${APP_NAME} ${APP_VERSION}"
!ifdef GENERATE_UNINSTALLER_ONLY
  OutFile "${UNINSTALLER_GENERATOR_EXE}"
  SilentInstall silent
!else
  OutFile "${OUT_FILE}"
!endif

InstallDir "$LOCALAPPDATA\Programs\${APP_ID}"
InstallDirRegKey HKCU "${UNINSTALL_REG_KEY}" "InstallLocation"
BrandingText "${APP_NAME} · Windows x64 Per-User 安装包"

; 使用 LZMA 固实压缩（严禁使用 UPX 等易触发杀软误报的加壳工具）
SetCompressor /SOLID lzma
SetCompressorDictSize 32

; 版本资源元数据
VIProductVersion "${APP_VI_VERSION}"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} Windows x64 安装程序"
VIAddVersionKey "FileVersion" "${APP_VI_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright (c) Jiangjie Studio"

; MUI2 配置
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_UNFINISHPAGE_NOAUTOCLOSE

!ifndef GENERATE_UNINSTALLER_ONLY
  !insertmacro MUI_PAGE_WELCOME
  !insertmacro MUI_PAGE_DIRECTORY
  !insertmacro MUI_PAGE_INSTFILES
  !insertmacro MUI_PAGE_FINISH

  !insertmacro MUI_UNPAGE_CONFIRM
  !insertmacro MUI_UNPAGE_INSTFILES
!endif

!insertmacro MUI_LANGUAGE "SimpChinese"

; 全局变量
Var NoLaunchFlag
Var PurgeDataFlag
Var PrevSeq
Var PrevVer

Function .onInit
  !ifdef GENERATE_UNINSTALLER_ONLY
    WriteUninstaller "${UNINSTALLER_OUTPUT_PATH}"
    Quit
  !endif

  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "${APP_NAME} 仅支持 64 位 Windows（x64）系统。"
    Abort
  ${EndIf}

  ; 严格拒绝写系统目录（防止无意间触发 UAC 或权限失败）
  SetShellVarContext current

  ; 解析命令行参数 /NOLAUNCH
  ${GetParameters} $R0
  StrCpy $NoLaunchFlag "0"
  ${GetOptions} $R0 "/NOLAUNCH" $R1
  ${IfNot} ${Errors}
    StrCpy $NoLaunchFlag "1"
  ${EndIf}
FunctionEnd

Function un.onInit
  SetShellVarContext current
  ${GetParameters} $R0
  StrCpy $PurgeDataFlag "0"
  ${GetOptions} $R0 "/PURGEDATA" $R1
  ${IfNot} ${Errors}
    StrCpy $PurgeDataFlag "1"
  ${EndIf}
FunctionEnd

; 写入版本激活清单 current.json（原子替换）
Function WriteCurrentManifest
  StrCpy $PrevSeq "0"
  StrCpy $PrevVer ""
  IfFileExists "$INSTDIR\current.json" 0 write_fresh
    ReadRegStr $PrevSeq HKCU "${UNINSTALL_REG_KEY}" "JiangjieReleaseSequence"
    ReadRegStr $PrevVer HKCU "${UNINSTALL_REG_KEY}" "DisplayVersion"
    ${If} $PrevSeq == ""
      StrCpy $PrevSeq "0"
    ${EndIf}
    ${If} $PrevSeq == "${RELEASE_SEQUENCE}"
      StrCpy $PrevSeq "0"
      StrCpy $PrevVer ""
    ${EndIf}

  write_fresh:
  FileOpen $0 "$INSTDIR\current.json.tmp" w
  FileWrite $0 "{$\r$\n"
  FileWrite $0 '  "schemaVersion": 1,$\r$\n'
  FileWrite $0 '  "channel": "${RELEASE_CHANNEL}",$\r$\n'
  FileWrite $0 '  "version": "${APP_VERSION}",$\r$\n'
  FileWrite $0 '  "releaseSequence": ${RELEASE_SEQUENCE},$\r$\n'
  FileWrite $0 '  "previousSequence": $PrevSeq,$\r$\n'
  FileWrite $0 '  "previousVersion": "$PrevVer",$\r$\n'
  FileWrite $0 '  "healthySequence": ${RELEASE_SEQUENCE},$\r$\n'
  FileWrite $0 '  "unverifiedAttempts": 0$\r$\n'
  FileWrite $0 "}$\r$\n"
  FileClose $0

  Delete "$INSTDIR\current.json"
  Rename "$INSTDIR\current.json.tmp" "$INSTDIR\current.json"
FunctionEnd

Section "MainApplication" SEC_MAIN
  !ifdef GENERATE_UNINSTALLER_ONLY
    Return
  !endif

  SetOutPath "$INSTDIR"

  ; 1. 稳定入口 Launcher 与独立增量更新助手
  File "${STAGE_DIR}\Jiangjie.exe"
  File "${STAGE_DIR}\JiangjieUpdater.exe"

  ; 2. 落盘至版本隔离目录 versions\<releaseSequence>\
  SetOutPath "$INSTDIR\versions\${RELEASE_SEQUENCE}"
  File "${STAGE_DIR}\JiangjieApp.exe"
  File "${STAGE_DIR}\BohackCredentialStore.exe"
  File "${STAGE_DIR}\desktop-agent.patch.yml"
  File "${STAGE_DIR}\runtime-bom.json"
  !ifdef COMPONENT_HASHES_FILE
    File "${COMPONENT_HASHES_FILE}"
  !endif
  !ifdef RELEASE_DESCRIPTOR_FILE
    File "${RELEASE_DESCRIPTOR_FILE}"
  !endif

  File /r "${STAGE_DIR}\desktop"
  File /r "${STAGE_DIR}\dsh-workbench-fix"
  File /r "${STAGE_DIR}\video-kit"
  File /r "${STAGE_DIR}\runtime"

  ; 3. 写入或嵌入已签名的卸载器
  SetOutPath "$INSTDIR"
  !ifdef PREBUILT_UNINSTALLER
    File "/oname=$INSTDIR\Uninstall.exe" "${PREBUILT_UNINSTALLER}"
  !else
    WriteUninstaller "$INSTDIR\Uninstall.exe"
  !endif

  ; 4. 原子写入 current.json 并清除过期 pending-update.json
  Delete "$INSTDIR\pending-update.json"
  Call WriteCurrentManifest

  ; 5. 创建当前用户桌面快捷方式与开始菜单入口
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\Jiangjie.exe" "" "$INSTDIR\Jiangjie.exe" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\Jiangjie.exe" "" "$INSTDIR\Jiangjie.exe" 0

  ; 6. 写入标准 HKCU 卸载注册表项（无需管理员权限）
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0

  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "URLInfoAbout" "${APP_URL}"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "DisplayIcon" "$INSTDIR\Jiangjie.exe,0"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "JiangjieReleaseSequence" "${RELEASE_SEQUENCE}"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "JiangjieChannel" "${RELEASE_CHANNEL}"
  WriteRegDWORD HKCU "${UNINSTALL_REG_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_REG_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINSTALL_REG_KEY}" "EstimatedSize" "$0"
SectionEnd

Function .onInstSuccess
  ; 双击默认安装完成后自动拉起 Jiangjie.exe；静默 /S 或 /NOLAUNCH 不自动拉起
  ${IfNot} ${Silent}
    ${If} $NoLaunchFlag != "1"
      Exec '"$INSTDIR\Jiangjie.exe"'
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetShellVarContext current

  ; 删除桌面与开始菜单快捷方式
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  ; 清除运行时可能存在的只读属性，确保安装目录可彻底清理
  nsExec::Exec '"$SYSDIR\attrib.exe" -R "$INSTDIR\*.*" /S /D'

  ; 删除程序安装目录与运行时缓存
  RMDir /r "$INSTDIR\versions"
  Delete "$INSTDIR\Jiangjie.exe"
  Delete "$INSTDIR\JiangjieUpdater.exe"
  Delete "$INSTDIR\current.json"
  Delete "$INSTDIR\pending-update.json"
  Delete "$INSTDIR\failed-sequences.json"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"

  ; 清理本地缓存（保留日志便于排障，用户若选择清空数据则一并清理）
  RMDir /r "$LOCALAPPDATA\${APP_ID}\cache"
  RMDir /r "$LOCALAPPDATA\${APP_ID}\webview2"

  ; 卸载时询问是否保留 %APPDATA%\Jiangjie 用户创作数据（默认保留）
  ${If} ${Silent}
    ${If} $PurgeDataFlag == "1"
      RMDir /r "$APPDATA\${APP_ID}"
      RMDir /r "$LOCALAPPDATA\${APP_ID}"
    ${EndIf}
  ${Else}
    IfFileExists "$APPDATA\${APP_ID}\*.*" 0 skip_data_prompt
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
        "卸载程序已移除 ${APP_NAME} 应用本体。$\r$\n$\r$\n是否同时删除您的创作项目、蓝图和个人设置（$APPDATA\${APP_ID}）？$\r$\n$\r$\n点击「否」（推荐）将保留您的全部创作数据。" \
        IDYES purge_user_data IDNO skip_data_prompt
      purge_user_data:
        RMDir /r "$APPDATA\${APP_ID}"
        RMDir /r "$LOCALAPPDATA\${APP_ID}"
    skip_data_prompt:
  ${EndIf}

  ; 删除 HKCU 卸载注册表项
  DeleteRegKey HKCU "${UNINSTALL_REG_KEY}"
SectionEnd
