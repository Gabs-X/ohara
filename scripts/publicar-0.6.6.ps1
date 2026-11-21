$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'C:\repositorios\Projetos-Pessoais\ohara'

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program falhou (código $LASTEXITCODE). A publicação foi interrompida." }
}

Invoke-Checked 'gh' @('auth', 'status')
Invoke-Checked 'git' @('add', '--', 'AGENTS.md', 'package.json', 'package-lock.json', 'src/integrations/whatsapp.js', 'src/integrations/whatsapp-web.js', 'src/integrations/whatsapp-dom.js', 'test/whatsapp.test.js', 'test/whatsapp-dom.test.js', 'scripts/publicar-0.6.6.ps1')
& git diff --cached --quiet
if ($LASTEXITCODE -eq 1) {
    Invoke-Checked 'git' @('commit', '-m', 'v0.6.6: corrige busca e abertura de contatos no WhatsApp')
} elseif ($LASTEXITCODE -ne 0) { throw 'Não foi possível verificar as alterações preparadas.' }

& git rev-parse --verify refs/tags/v0.6.6 2>$null
if ($LASTEXITCODE -ne 0) {
    Invoke-Checked 'git' @('tag', '-a', 'v0.6.6', '-m', 'Ohara 0.6.6')
} else {
    $tagCommit = & git rev-list -n 1 v0.6.6
    $headCommit = & git rev-parse HEAD
    if ($tagCommit -ne $headCommit) { throw 'A tag v0.6.6 já aponta para outro commit. Nada foi sobrescrito.' }
}
Invoke-Checked 'git' @('push', 'origin', 'HEAD:master', 'refs/tags/v0.6.6')
Invoke-Checked 'gh' @('release', 'create', 'v0.6.6', 'dist/Ohara-Setup-0.6.6.exe', 'dist/Ohara-Portatil-0.6.6.exe', '--repo', 'Gabs-X/ohara', '--verify-tag', '--title', 'Ohara 0.6.6', '--notes-file', 'dist/notas-0.6.6.md', '--latest')
Invoke-Checked 'gh' @('release', 'view', 'v0.6.6', '--repo', 'Gabs-X/ohara', '--json', 'url,assets')
