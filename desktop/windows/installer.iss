#ifndef SourceDir
  #error SourceDir must point to the packaged application directory
#endif
#ifndef OutputDir
  #error OutputDir must point to the desired installer output directory
#endif

[Setup]
AppId={{0EC3E73C-1E13-46DD-98C7-C5758133B4AB}
AppName=讲界视频工坊
AppVersion=0.2.1
AppPublisher=讲界
DefaultDirName={localappdata}\Programs\Jiangjie
DefaultGroupName=讲界
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=Jiangjie-Windows-x64-0.2.1-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\Jiangjie.exe

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\讲界"; Filename: "{app}\Jiangjie.exe"
Name: "{autodesktop}\讲界"; Filename: "{app}\Jiangjie.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; Flags: unchecked

[Run]
Filename: "{app}\Jiangjie.exe"; Description: "启动讲界"; Flags: nowait postinstall skipifsilent
