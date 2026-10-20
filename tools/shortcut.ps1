param([string]$Target, [string]$Arguments = "", [string]$WorkDir, [string]$Icon)
if ($Arguments -and $Arguments -notmatch '^"') { $Arguments = '"' + $Arguments + '"' }
$shell = New-Object -ComObject WScript.Shell
$dirs = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))
foreach ($dir in $dirs) {
  $lnk = $shell.CreateShortcut((Join-Path $dir 'Buddy.lnk'))
  $lnk.TargetPath = $Target
  $lnk.Arguments = $Arguments
  $lnk.WorkingDirectory = $WorkDir
  if (Test-Path $Icon) { $lnk.IconLocation = $Icon }
  $lnk.Description = 'Buddy - local AI companion'
  $lnk.Save()
}
