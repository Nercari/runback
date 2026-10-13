$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $repo 'policy-watch.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $launcher)
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 9:00AM
Register-ScheduledTask -TaskName 'Runback Policy Watch' -Action $action -Trigger $trigger -Description 'Check Blizzard policy pages for changes.' -Force | Out-Null
