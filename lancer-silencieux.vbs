' Lance demarrer-boucle.bat sans fenetre console visible (utilise par la tache
' planifiee creee par install-windows.ps1). Le chemin est resolu dynamiquement,
' ce fichier reste donc valable quel que soit le dossier d'installation.
Dim fso, dossier, shell

Set fso = CreateObject("Scripting.FileSystemObject")
dossier = fso.GetParentFolderName(WScript.ScriptFullName)

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = dossier
shell.Run "cmd /c """ & dossier & "\demarrer-boucle.bat""", 0, False
