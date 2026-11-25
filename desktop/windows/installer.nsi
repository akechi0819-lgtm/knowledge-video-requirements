# -*- coding: utf-8 -*-
Unicode True
!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"

!ifndef SourceDir
  !error "SourceDir must point to the application stage"
!endif
!ifndef OutputDir
  !error "OutputDir must point to the installer output directory"
!endif
!ifndef UninstallManifest
  !error "UninstallManifest must identify the generated file manifest"
!endif

Name "讲界视频工坊"
OutFile "${OutputDir}\Jiangjie-Windows-x64-0.2.1-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\Jiangjie"
RequestExecutionLevel user
SetCompressor /SOLID zlib
ShowInstDetails show
ShowUninstDetails show

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "讲界需要 Windows x64。"
    Abort
  ${EndIf}
  SetShellVarContext current
FunctionEnd

Section "讲界"
  SetOutPath "$INSTDIR"
  File /r "${SourceDir}\*"
  CreateDirectory "$SMPROGRAMS\讲界"
  CreateShortcut "$SMPROGRAMS\讲界\讲界.lnk" "$INSTDIR\Jiangjie.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jiangjie" "DisplayName" "讲界视频工坊"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jiangjie" "DisplayVersion" "0.2.1"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jiangjie" "Publisher" "讲界"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jiangjie" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jiangjie" "DisplayIcon" "$INSTDIR\Jiangjie.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jiangjie" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jiangjie" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$SMPROGRAMS\讲界\讲界.lnk"
  RMDir "$SMPROGRAMS\讲界"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jiangjie"
  !include "${UninstallManifest}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
