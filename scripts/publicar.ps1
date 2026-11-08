$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
$setup = "dist/Ohara-Setup-$version.exe"
$portable = "dist/Ohara-Portatil-$version.exe"
$notes = "dist/notas-$version.md"

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program falhou (codigo $LASTEXITCODE). Publicacao interrompida." }
}

foreach ($file in @($setup, $portable, $notes)) {
    if (!(Test-Path -LiteralPath $file)) { throw "Arquivo ausente: $file" }
}
Invoke-Checked 'gh' @('auth', 'status')
Invoke-Checked 'git' @('add', '--', 'AGENTS.md', 'package.json', 'package-lock.json', 'src/integrations/whatsapp.js', 'src/integrations/whatsapp-web.js', 'src/integrations/whatsapp-dom.js', 'src/integrations/whatsapp-input.js', 'test/whatsapp.test.js', 'test/whatsapp-dom.test.js', 'test/whatsapp-input.test.js', 'scripts/publicar.ps1')
& git diff --cached --quiet
if ($LASTEXITCODE -eq 1) {
    Invoke-Checked 'git' @('commit', '-m', "${tag}: corrige foco da janela do WhatsApp")
} elseif ($LASTEXITCODE -ne 0) { throw 'Falha ao verificar alteracoes preparadas.' }

$existingTag = & git tag --list $tag
if ($LASTEXITCODE -ne 0) { throw 'Falha ao consultar tags.' }
if (!$existingTag) {
    Invoke-Checked 'git' @('tag', '-a', $tag, '-m', "Ohara $version")
} else {
    $tagCommit = & git rev-list -n 1 $tag
    $headCommit = & git rev-parse HEAD
    if ($tagCommit -ne $headCommit) { throw "A tag $tag aponta para outro commit. Nada foi sobrescrito." }
}
Invoke-Checked 'git' @('push', 'origin', 'HEAD:master', "refs/tags/$tag")
& gh release view $tag --repo Gabs-X/ohara --json url 2>$null
if ($LASTEXITCODE -eq 0) {
    Invoke-Checked 'gh' @('release', 'upload', $tag, $setup, $portable, '--repo', 'Gabs-X/ohara', '--clobber')
} else {
    Invoke-Checked 'gh' @('release', 'create', $tag, $setup, $portable, '--repo', 'Gabs-X/ohara', '--verify-tag', '--title', "Ohara $version", '--notes-file', $notes, '--latest')
}
Invoke-Checked 'gh' @('release', 'view', $tag, '--repo', 'Gabs-X/ohara', '--json', 'url,assets')
